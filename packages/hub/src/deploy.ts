import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger, type DeployStatusSchema } from "@aso/shared";
import type { PushNotification } from "./push/changes.js";
import { JsonFileWriter } from "./push/json-file.js";

const log = createLogger("deploy");

/** The operator's deploy commands, in the Hub-wide state folder: never from a project's repository, which agents change. */
export const DEPLOY_FILE = "deploy.json";
export const DEPLOY_TIMEOUT_SEC = 900;
/** The commit each project last deployed successfully, beside `deploy.json`, so a restart knows what is live. */
export const DEPLOYED_FILE = "deployed.json";
/** Characters of a deploy's output kept (the end, where errors are): in `DeployStatus.output` and `deploy/<id>.log`. */
const OUTPUT_TAIL = 20_000;
/** The Hub's environment a deploy command sees; the rest (GitHub and model API tokens) stays with the Hub. */
const PASSED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_HOST", "DOCKER_CONFIG"];

const DeployCommandSchema = z.strictObject({
  /** Run with `sh -c` in a fresh export of main at the merged commit. */
  command: z.string().min(1).max(4000),
  timeoutSec: z.number().int().min(10).max(3600).optional(),
  /** Extra environment variables for the command. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
});
export type DeployCommand = z.infer<typeof DeployCommandSchema>;
export const DeployFileSchema = z.record(z.string(), DeployCommandSchema);

export type DeployStatus = z.infer<typeof DeployStatusSchema>;

/** A commit as notifications, logs and `ASO_DEPLOY_SHORT` show it. */
const short = (commit: string) => commit.slice(0, 7);

/** The environment a deploy command runs with: the allowlisted part of the Hub's, the entry's own, and what it deploys. */
export function deployEnv(command: DeployCommand, project: string, commit: string, hubEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_ENV) if (hubEnv[name] !== undefined) env[name] = hubEnv[name];
  return { ...env, ...command.env, ASO_DEPLOY_PROJECT: project, ASO_DEPLOY_COMMIT: commit, ASO_DEPLOY_SHORT: short(commit) };
}

/** What the deployer needs of a project. */
export interface DeployTarget {
  id: string;
  dir: string;
  repo: { mainHead(): Promise<string> };
}

export interface DeployJob {
  project: string;
  commit: string;
  command: DeployCommand;
}

export interface RunResult {
  ok: boolean;
  error?: string;
  /** When the command ran to its end and failed: its exit code. Not set when it was stopped or couldn't start. */
  exitCode?: number;
  output: string;
}

/**
 * Whether a deploy failed in the project's own command (it ran and exited non-zero), rather than
 * the Hub failing to start it or stopping it: only that says something about the work merged.
 */
export function failedInCommand(status: Pick<DeployStatus, "state" | "exitCode">): boolean {
  return status.state === "failed" && status.exitCode !== undefined;
}

/** Runs a job's command in `cwd`, the export of its commit. */
export type RunDeploy = (job: DeployJob, cwd: string) => Promise<RunResult>;

/** Runs the command here, in the Hub's own process (a Hub that is not in a container). */
export const runHere: RunDeploy = (job, cwd) =>
  runCommand(job.command.command, { cwd, env: deployEnv(job.command, job.project, job.commit), timeoutSec: job.command.timeoutSec ?? DEPLOY_TIMEOUT_SEC });

/** Where a job's export is, under the folder that holds `deploy.json`. */
export const deployWorkDir = (stateDir: string, project: string) => path.join(stateDir, "deploy", project);

export interface DeployerOptions {
  /** Holds `deploy.json`, `deployed.json`, and `deploy/` for the exports and logs. */
  dir: string;
  onResult?: (project: string, status: DeployStatus) => void;
  /** Default: `runHere`. A Hub in a container hands jobs to the host instead (`HostDeployQueue`). */
  run?: RunDeploy;
}

/**
 * Deploys a project after each merge into its main, when the operator gave it a command in
 * `deploy.json`. One deploy per project at a time; merges that land meanwhile are deployed together
 * once it ends. The file is read again on every deploy, so edits apply without a Hub restart.
 */
export class Deployer {
  private readonly last = new Map<string, DeployStatus>();
  private readonly running = new Set<string>();
  /** One more deploy after the running one, and whether any request for it was forced. */
  private readonly again = new Map<string, boolean>();
  private readonly lastDeployedCommit = new Map<string, string>();
  private readonly deployedPath: string;
  private readonly deployedFile: JsonFileWriter;
  private config: Record<string, DeployCommand> = {};
  private configError?: string;

  constructor(private readonly opts: DeployerOptions) {
    this.deployedPath = path.join(opts.dir, DEPLOYED_FILE);
    this.deployedFile = new JsonFileWriter(this.deployedPath);
  }

  /**
   * Read which commit each project last deployed. With it, requesting every project when the Hub
   * starts deploys only what changed while it was down, or what a restart cut off.
   */
  async restore(): Promise<void> {
    try {
      const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(await readFile(this.deployedPath, "utf8")));
      if (!parsed.success) throw new Error("not a map of project to commit");
      for (const [project, commit] of Object.entries(parsed.data)) this.lastDeployedCommit.set(project, commit);
    } catch (err) {
      // Without it, each project deploys once more: safe, a deploy replaces what runs.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${this.deployedPath} is invalid or unreadable, ignored: ${(err as Error).message}`);
    }
  }

  get file(): string {
    return path.join(this.opts.dir, DEPLOY_FILE);
  }

  /**
   * Read `deploy.json`. A missing file means no project deploys. An unreadable or invalid one keeps
   * the last good commands and is reported when one of those projects deploys, so a half-saved
   * edit neither stops deploys silently nor reports failures for projects that never deploy.
   */
  async load(): Promise<void> {
    let config: Record<string, DeployCommand> = {};
    let error: string | undefined;
    try {
      const parsed = DeployFileSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`).join("; "));
      config = parsed.data;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        error = `${this.file} is invalid or unreadable: ${(err as Error).message}`;
        config = this.config;
        log.warn(error);
      }
    }
    this.config = config;
    this.configError = error;
  }

  configured(project: string): boolean {
    return project in this.config;
  }

  view(project: string): { configured: boolean; last?: DeployStatus } {
    const last = this.last.get(project);
    return { configured: this.configured(project), ...(last ? { last } : {}) };
  }

  /**
   * Deploy the project's main now, or right after the deploy in progress. Nothing happens for a
   * project without a command, or when main is the commit it last deployed, unless `force`: a
   * merge can be reported twice (by ASO and by catching up with GitHub), "Deploy now" means it.
   */
  request(project: DeployTarget, opts: { force?: boolean } = {}): void {
    const force = opts.force ?? false;
    if (this.running.has(project.id)) {
      this.again.set(project.id, force || (this.again.get(project.id) ?? false));
      return;
    }
    this.running.add(project.id);
    void (async () => {
      try {
        // A request during a deploy sets `again`; clearing it before each run makes any number of
        // them one more deploy, of main as it is by then.
        let next: boolean | undefined = force;
        while (next !== undefined) {
          this.again.delete(project.id);
          await this.deploy(project, next);
          next = this.again.get(project.id);
        }
      } finally {
        this.running.delete(project.id);
      }
    })();
  }

  private alreadyDeployed(project: string, commit: string): boolean {
    return commit !== "" && this.lastDeployedCommit.get(project) === commit;
  }

  private async deploy(project: DeployTarget, force: boolean): Promise<void> {
    await this.load();
    const command = this.config[project.id];
    if (!command) return;
    const commit = await project.repo.mainHead().catch(() => "");
    if (!force && this.alreadyDeployed(project.id, commit)) {
      log.debug(`${project.id} @ ${short(commit)}: already deployed`);
      return;
    }
    const status: DeployStatus = { state: "running", commit, startedAt: new Date().toISOString() };
    this.last.set(project.id, status);
    const finish = (result: Pick<DeployStatus, "state" | "error" | "exitCode" | "output">) => {
      Object.assign(status, result, { finishedAt: new Date().toISOString() });
      log[result.state === "succeeded" ? "info" : "warn"](
        `${project.id} @ ${short(status.commit)}: deploy ${result.state}${result.error ? `: ${result.error}` : ""}`,
      );
      this.opts.onResult?.(project.id, status);
    };
    // Deploying with the last good command would hide the broken edit until it mattered more.
    if (this.configError) return finish({ state: "failed", error: this.configError });
    if (!status.commit) return finish({ state: "failed", error: "could not read the project's main" });

    const work = deployWorkDir(this.opts.dir, project.id);
    const logFile = `${work}.log`;
    try {
      await exportCommit(project.dir, status.commit, work);
    } catch (err) {
      return finish({ state: "failed", error: `could not export ${short(status.commit)}: ${(err as Error).message}` });
    }
    log.info(`${project.id} @ ${short(status.commit)}: deploying`);
    const result = await (this.opts.run ?? runHere)({ project: project.id, commit: status.commit, command }, work);
    await writeFile(logFile, result.output).catch(() => undefined);
    if (result.ok) {
      this.lastDeployedCommit.set(project.id, status.commit);
      await this.deployedFile.write(Object.fromEntries(this.lastDeployedCommit));
    }
    finish(
      result.ok
        ? { state: "succeeded", output: result.output }
        : { state: "failed", error: result.error, ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}), output: result.output },
    );
  }
}

/** `dir` becomes a clean copy of `commit`'s files (no .git, nothing left from the last deploy). */
async function exportCommit(repoDir: string, commit: string, dir: string): Promise<void> {
  const tar = `${dir}.tar`;
  await rm(dir, { recursive: true, force: true }); // the deployer's own folder under the Hub's state
  await mkdir(dir, { recursive: true });
  try {
    await exec("git", ["-C", repoDir, "archive", "--format=tar", "-o", tar, commit]);
    await exec("tar", ["-xf", tar, "-C", dir]);
  } finally {
    await rm(tar, { force: true });
  }
}

function exec(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 120_000 }, (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())),
  );
}

/** Run `sh -c command`; on timeout its whole process group is stopped. Output is stdout and stderr together. */
export function runCommand(
  command: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutSec: number },
): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
    };
    const child = spawn("sh", ["-c", command], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const stop = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 5_000).unref();
    }, opts.timeoutSec * 1000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message, output });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) resolve({ ok: false, error: `timed out after ${opts.timeoutSec} s`, output });
      else if (code === 0) resolve({ ok: true, output });
      else if (code === null) resolve({ ok: false, error: `stopped by ${signal}`, output });
      else resolve({ ok: false, error: `exited with code ${code}`, exitCode: code, output });
    });
  });
}

/** What the phone shows when a deploy ends. */
export function deployNotification(project: string, status: DeployStatus): PushNotification {
  const commit = short(status.commit);
  const base = { url: `/projects/${encodeURIComponent(project)}`, tag: `deploy-${project}` };
  if (status.state === "succeeded") return { ...base, title: `${project}: deployed`, body: `${commit} is live.` };
  const lastLines = (status.output ?? "").trim().split("\n").slice(-3).join("\n");
  const body = [`${commit ? `${commit}: ` : ""}${status.error ?? "failed"}`, lastLines].filter(Boolean).join("\n");
  return { ...base, title: `${project}: deploy failed`, body: body.length > 600 ? `${body.slice(0, 599)}…` : body };
}

/** How long a queued job waits for the host to take it before it fails. */
export const HOST_PICKUP_MS = 60_000;
/** How much longer than the command's own timeout the Hub waits for the host's result. */
const HOST_REPORT_GRACE_MS = 60_000;

interface Pending {
  job: DeployJob;
  resolve: (r: RunResult) => void;
  timer: NodeJS.Timeout;
}

/**
 * Deploy jobs for a Hub in a container, which has no Docker or host tools of its own: the
 * `aso start-hub --docker` process on the host takes them (`GET /api/deploys/next`), runs the
 * command in the same export (the projects folder is shared) and reports back. A job nobody
 * takes, or whose result never comes, fails instead of waiting forever.
 */
export class HostDeployQueue {
  private readonly waiting = new Map<string, Pending>();
  private readonly taken = new Map<string, Pending>();

  constructor(private readonly opts: { pickupMs?: number; graceMs?: number } = {}) {}

  readonly run: RunDeploy = (job) =>
    new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ ok: false, error: "no host runner took the job: is `aso start-hub --docker` running on the Hub machine?", output: "" });
      }, this.opts.pickupMs ?? HOST_PICKUP_MS);
      this.waiting.set(id, { job, resolve, timer });
    });

  /** The oldest job nobody has taken yet; taking it starts the wait for its result. */
  next(): (DeployJob & { id: string }) | undefined {
    const first = this.waiting.entries().next();
    if (first.done) return undefined;
    const [id, pending] = first.value;
    this.waiting.delete(id);
    clearTimeout(pending.timer);
    const waitMs = (pending.job.command.timeoutSec ?? DEPLOY_TIMEOUT_SEC) * 1000 + (this.opts.graceMs ?? HOST_REPORT_GRACE_MS);
    pending.timer = setTimeout(() => {
      this.taken.delete(id);
      pending.resolve({ ok: false, error: "the host runner took the job but never reported a result", output: "" });
    }, waitMs);
    this.taken.set(id, pending);
    return { id, ...pending.job };
  }

  /** The host's result for a job it took. False for a job this Hub doesn't know (e.g. from before a restart). */
  complete(id: string, result: RunResult): boolean {
    const pending = this.taken.get(id);
    if (!pending) return false;
    this.taken.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }
}
