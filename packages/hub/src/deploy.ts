import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger, type DeployStatusSchema } from "@aso/shared";
import type { PushNotification } from "./push/changes.js";

const log = createLogger("deploy");

/** The operator's deploy commands, in the Hub-wide state folder: never from a project's repository, which agents change. */
export const DEPLOY_FILE = "deploy.json";
export const DEPLOY_TIMEOUT_SEC = 900;
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

export interface DeployerOptions {
  /** Holds `deploy.json`, and `deploy/` for the exports and logs. */
  dir: string;
  onResult?: (project: string, status: DeployStatus) => void;
}

/**
 * Deploys a project after each merge into its main, when the operator gave it a command in
 * `deploy.json`. One deploy per project at a time; merges that land meanwhile are deployed together
 * once it ends. The file is read again on every deploy, so edits apply without a Hub restart.
 */
export class Deployer {
  private readonly last = new Map<string, DeployStatus>();
  private readonly running = new Set<string>();
  private readonly again = new Set<string>();
  private config: Record<string, DeployCommand> = {};
  private configError?: string;

  constructor(private readonly opts: DeployerOptions) {}

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

  /** Deploy the project's main now, or right after the deploy in progress. Nothing happens for a project without a command. */
  request(project: DeployTarget): void {
    if (this.running.has(project.id)) {
      this.again.add(project.id);
      return;
    }
    this.running.add(project.id);
    void (async () => {
      try {
        // A request during a deploy sets `again`; clearing it before each run makes any number of
        // them one more deploy, of main as it is by then.
        do {
          this.again.delete(project.id);
          await this.deploy(project);
        } while (this.again.has(project.id));
      } finally {
        this.running.delete(project.id);
      }
    })();
  }

  private async deploy(project: DeployTarget): Promise<void> {
    await this.load();
    const command = this.config[project.id];
    if (!command) return;
    const status: DeployStatus = { state: "running", commit: await project.repo.mainHead().catch(() => ""), startedAt: new Date().toISOString() };
    this.last.set(project.id, status);
    const finish = (result: Pick<DeployStatus, "state" | "error" | "output">) => {
      Object.assign(status, result, { finishedAt: new Date().toISOString() });
      log[result.state === "succeeded" ? "info" : "warn"](
        `${project.id} @ ${short(status.commit)}: deploy ${result.state}${result.error ? `: ${result.error}` : ""}`,
      );
      this.opts.onResult?.(project.id, status);
    };
    // Deploying with the last good command would hide the broken edit until it mattered more.
    if (this.configError) return finish({ state: "failed", error: this.configError });
    if (!status.commit) return finish({ state: "failed", error: "could not read the project's main" });

    const work = path.join(this.opts.dir, "deploy", project.id);
    const logFile = `${work}.log`;
    try {
      await exportCommit(project.dir, status.commit, work);
    } catch (err) {
      return finish({ state: "failed", error: `could not export ${short(status.commit)}: ${(err as Error).message}` });
    }
    log.info(`${project.id} @ ${short(status.commit)}: deploying`);
    const env = deployEnv(command, project.id, status.commit);
    const result = await runCommand(command.command, { cwd: work, env, timeoutSec: command.timeoutSec ?? DEPLOY_TIMEOUT_SEC });
    await writeFile(logFile, result.output).catch(() => undefined);
    finish(result.ok ? { state: "succeeded", output: result.output } : { state: "failed", error: result.error, output: result.output });
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
): Promise<{ ok: boolean; error?: string; output: string }> {
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
      else resolve({ ok: false, error: code === null ? `stopped by ${signal}` : `exited with code ${code}`, output });
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
