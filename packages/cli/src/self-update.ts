import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createLogger, TASK_AT_WORK, type HubUpdate, type TaskState } from "@aso/shared";
import { execCommand, type Exec } from "./exec.js";
import { HubVersions } from "./hub-versions.js";

const log = createLogger("update");

/** How often the updater asks the repository for a newer main. */
export const UPDATE_POLL_MS = 5 * 60_000;
/** How often it checks whether the swarm is idle, while an update waits for that. */
export const IDLE_POLL_MS = 30_000;
/** How long a new version has to confirm itself (the Docker image is built in that time too) before it is rolled back. */
export const CONFIRM_DEADLINE_SEC = 15 * 60;
/** Where the Hub's versions and the updater's files live, written into the service unit so every process agrees. */
export const HUB_HOME_ENV = "ASO_HUB_HOME";
/** How long a new version must answer, as itself, before it confirms. */
export const CONFIRM_STABLE_MS = 60_000;
/** How long a restart may take to stop this process before it counts as not having happened. */
export const RESTART_GRACE_MS = 2 * 60_000;
/** A commit whose build or tests failed is tried this often (a flaky test, the network); one that didn't come up, once. */
export const BUILD_ATTEMPTS = 3;
const CLONE_TIMEOUT_MS = 10 * 60_000;
const NPM_CI_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 30 * 60_000;
const PACKAGE_TIMEOUT_MS = 20 * 60_000;

export type Report = Omit<HubUpdate, "at" | "current">;

/** Where the updater keeps things: the versions, its state, and the build's clone and home. */
export interface UpdatePaths {
  versions: string;
  state: string;
  work: string;
}

export function updatePaths(env: NodeJS.ProcessEnv = process.env): UpdatePaths {
  const root = env[HUB_HOME_ENV] || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "aso", "hub");
  return { versions: root, state: path.join(root, "update"), work: path.join(root, "build") };
}

/** The commit part of a version (`0.1.0+840bcd7` → `840bcd7`). */
export function buildOf(version: string): string {
  return version.split("+")[1] ?? "";
}

/** Whether `version` was built from `sha` (a clean build: a `-dirty` one never matches). */
export function isBuildOf(version: string, sha: string): boolean {
  const build = buildOf(version);
  return /^[0-9a-f]{7,40}$/.test(build) && sha.startsWith(build);
}

/**
 * Whether a changed file is documentation only, which never needs a new Hub: Markdown, the docs
 * folder (but not the API description, which code generates), GitHub's workflows and settings
 * (they run on GitHub, not in the Hub), the licence.
 */
export function isDocumentation(file: string): boolean {
  if (file === "docs/openapi.json") return false;
  return /\.md$/i.test(file) || file.startsWith("docs/") || file.startsWith(".github/") || file === "LICENSE";
}

/** Whether a range of commits changed only documentation (nothing at all doesn't count). */
export function onlyDocumentation(changedFiles: readonly string[]): boolean {
  return changedFiles.length > 0 && changedFiles.every(isDocumentation);
}

/** Whether a restart would interrupt nothing: no task at work, no deploy running, no plan being made. */
export function swarmIdle(
  tasks: ReadonlyArray<{ state: TaskState }>,
  projects: ReadonlyArray<{ deploy?: { last?: { state: string } } }>,
  plans: ReadonlyArray<{ state: string }>,
): boolean {
  return !tasks.some((t) => TASK_AT_WORK[t.state]) && !projects.some((p) => p.deploy?.last?.state === "running") && !plans.some((p) => p.state === "planning");
}

/**
 * The environment `npm ci`, the tests and the packaging of a new commit get: none of the Hub's
 * variables (its tokens, the API key) but `PATH`, the locale and the user name, and a home of
 * their own, so code that looks for files under `HOME` doesn't find the Hub's. This is not a
 * sandbox: the code runs as this user, so only merge into the followed branch what you would run.
 */
export function buildEnv(home: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ", "USER", "LOGNAME"].flatMap((k) => (env[k] === undefined ? [] : [[k, env[k]]])));
  return {
    ...kept,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CI: "1",
  };
}

/** Before installing: what the next start confirms, or the watchdog rolls back. */
export interface Pending {
  /** Names the update: its watchdog acts only on this one. */
  id: string;
  from: string;
  fromDir: string;
  to: string;
  toDir: string;
  target: string;
  /** ISO time after which an unconfirmed update is rolled back, also by a start after a reboot. */
  deadline: string;
}

interface Failure {
  error: string;
  attempts: number;
  /** Never tried again (it was installed and didn't come up). */
  permanent?: boolean;
}

/** The updater's state files, each written atomically (a crash leaves the old or the new one). */
export class UpdateState {
  constructor(readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  private async read<T>(name: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.file(name), "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private async write(name: string, data: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(name)}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, this.file(name));
  }

  pending = () => this.read<Pending>("pending.json");
  writePending = (p: Pending) => this.write("pending.json", p);
  clearPending = () => rm(this.file("pending.json"), { force: true });

  rolledBack = () => this.read<{ target: string; error: string }>("rolled-back.json");
  writeRolledBack = (r: { target: string; error: string }) => this.write("rolled-back.json", r);
  clearRolledBack = () => rm(this.file("rolled-back.json"), { force: true });

  async failure(sha: string): Promise<Failure | undefined> {
    return (await this.read<Record<string, Failure>>("failed.json"))?.[sha];
  }

  /** Whether `sha` is not to be tried again. */
  async givenUp(sha: string): Promise<boolean> {
    const f = await this.failure(sha);
    return !!f && (f.permanent === true || f.attempts >= BUILD_ATTEMPTS);
  }

  async markFailed(sha: string, error: string, permanent: boolean): Promise<void> {
    const all = (await this.read<Record<string, Failure>>("failed.json")) ?? {};
    all[sha] = { error, attempts: (all[sha]?.attempts ?? 0) + 1, ...(permanent ? { permanent } : {}) };
    await this.write("failed.json", all);
  }
}

export interface UpdaterOptions {
  hubUrl: string;
  token: string;
  /** Git URL of the ASO repository whose `branch` this Hub follows. */
  repo: string;
  branch?: string;
  paths: UpdatePaths;
  /** This build's version, `<version>+<commit>`. */
  current: string;
  exec?: Exec;
  /** Make the running version (its CLI at `entry`) check in `deadlineSec` that update `id` confirmed, else roll back. */
  armWatchdog: (entry: string, deadlineSec: number, id: string) => Promise<void>;
  /** Restart the service onto `current`, which stops this process (without waiting for that). */
  restart: () => void;
  pollMs?: number;
  idlePollMs?: number;
  stableMs?: number;
  restartGraceMs?: number;
}

/**
 * Keeps a Hub installed with `--update-from` on its repository's main. Every `pollMs` it looks for
 * a newer commit, builds and tests it in its own clone, installs it beside the running version,
 * waits until a restart interrupts nothing, arms a watchdog in the running (known good) version,
 * switches `current` and restarts. The new version confirms once it has answered as itself for
 * `stableMs`; if it never does, the watchdog switches back. Each step is reported to the Hub.
 */
export class HubUpdater {
  private readonly exec: Exec;
  private readonly versions: HubVersions;
  private readonly state: UpdateState;
  private readonly branch: string;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  /** The commit the updater's clone was last fetched for. */
  private fetched?: string;
  /**
   * A main found to differ from the running version in documentation only (logged once). Never
   * reset: a newer main is another commit, and gets its own look.
   */
  private docsOnly?: string;

  constructor(private readonly opts: UpdaterOptions) {
    this.exec = opts.exec ?? execCommand;
    this.versions = new HubVersions(opts.paths.versions);
    this.state = new UpdateState(opts.paths.state);
    this.branch = opts.branch ?? "main";
  }

  /** Once the Hub answers: report a rollback the watchdog made, and confirm an update this start is. */
  async afterStart(): Promise<void> {
    const rolledBack = await this.state.rolledBack();
    if (rolledBack && (await this.report({ state: "failed", target: rolledBack.target, error: rolledBack.error }))) {
      await this.state.clearRolledBack();
    }
    const pending = await this.state.pending();
    if (pending?.to !== this.opts.current) return;
    const stableMs = this.opts.stableMs ?? CONFIRM_STABLE_MS;
    let since = Date.now();
    while (!this.stopped) {
      if ((await this.answeringVersion()) !== this.opts.current) since = Date.now();
      else if (Date.now() - since >= stableMs) break;
      await sleep(Math.min(5_000, stableMs / 4));
    }
    if (this.stopped) return;
    await this.state.clearPending();
    await this.versions.prune([pending.toDir, pending.fromDir]);
    log.info(`updated ${pending.from} -> ${pending.to}`);
    await this.report({ state: "updated", target: pending.target });
  }

  start(): void {
    const loop = async () => {
      try {
        await this.check();
      } catch (err) {
        log.warn(`update check failed: ${(err as Error).message}`);
      }
      if (!this.stopped) this.timer = setTimeout(() => void loop(), this.opts.pollMs ?? UPDATE_POLL_MS);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** One pass: nothing to do, or build, install, wait, and switch onto it. */
  async check(): Promise<void> {
    const { current } = this.opts;
    let sha: string;
    try {
      sha = await this.remoteMain();
    } catch (err) {
      await this.report({ state: "failed", error: `could not read the repository's ${this.branch}: ${(err as Error).message}` });
      return;
    }
    if (isBuildOf(current, sha)) {
      await this.report({ state: "current" });
      return;
    }
    if (await this.state.givenUp(sha)) return; // reported when it failed; the next commit on main is tried
    if (await this.documentationOnly(sha)) {
      await this.report({ state: "current" });
      return;
    }
    const fromDir = await this.versions.current();
    if (!fromDir) return this.fail(sha, "this Hub was not installed with `aso hub-service install --update-from`, so there is no version to roll back to", true);

    let version: string;
    let toDir: string;
    const built = await this.versions.findBuild(sha);
    if (built) {
      version = built;
      toDir = this.versions.dirOf(built);
    } else {
      log.info(`${sha.slice(0, 7)} is newer than ${current}: building it`);
      await this.report({ state: "building", target: sha });
      try {
        version = await this.build(sha);
        toDir = await this.versions.install(version, path.join(this.opts.paths.work, "next.tgz"), this.exec);
      } catch (err) {
        return this.fail(sha, `build or tests failed: ${(err as Error).message}`, false);
      }
    }

    await this.report({ state: "waiting", target: sha });
    while (!this.stopped && !(await this.idle())) await sleep(this.opts.idlePollMs ?? IDLE_POLL_MS);
    if (this.stopped) return;
    if ((await this.remoteMain()) !== sha) return; // main moved while waiting: the next pass takes the newer one

    const id = randomUUID();
    const deadline = new Date(Date.now() + CONFIRM_DEADLINE_SEC * 1000).toISOString();
    try {
      await this.state.writePending({ id, from: current, fromDir, to: version, toDir, target: sha, deadline });
      await this.opts.armWatchdog(this.versions.entry(fromDir), CONFIRM_DEADLINE_SEC, id);
    } catch (err) {
      await this.state.clearPending();
      return this.fail(sha, `could not arm the rollback watchdog, so it was not installed: ${(err as Error).message}`, false);
    }
    await this.versions.setPrevious(fromDir);
    await this.versions.switchTo(toDir);
    await this.report({ state: "restarting", target: sha });
    log.info(`switched to ${version}; restarting`);
    this.stop();
    this.opts.restart();
    // A restart stops this process within seconds; one still here after the grace didn't happen.
    await new Promise((r) => setTimeout(r, this.opts.restartGraceMs ?? RESTART_GRACE_MS).unref());
    log.warn(`still running ${current} ${(this.opts.restartGraceMs ?? RESTART_GRACE_MS) / 1000} s after asking for a restart: undoing the switch`);
    await this.versions.switchTo(fromDir);
    await this.state.clearPending();
    await this.fail(sha, "the Hub service could not be restarted onto it", false);
  }

  private async remoteMain(): Promise<string> {
    // git with the Hub's own environment: its SSH agent, keys and git config reach the repository.
    const out = await this.exec("git", ["ls-remote", this.opts.repo, `refs/heads/${this.branch}`], { timeoutMs: 60_000 });
    const sha = out.split(/\s/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the repository has no ${this.branch} branch`);
    return sha;
  }

  /**
   * Whether main differs from the running version in documentation only (a README or a guide):
   * then there is nothing to build or restart for. Unsure (no clone, an unknown commit): no.
   */
  private async documentationOnly(sha: string): Promise<boolean> {
    if (this.docsOnly === sha) return true;
    const running = buildOf(this.opts.current);
    if (!/^[0-9a-f]{7,40}$/.test(running)) return false;
    try {
      const src = await this.fetchSource(sha);
      const changed = (await this.exec("git", ["diff", "--name-only", running, sha], { cwd: src })).split("\n").map((f) => f.trim()).filter(Boolean);
      if (!onlyDocumentation(changed)) return false;
    } catch (err) {
      log.debug(`could not tell what changed since ${running}: ${(err as Error).message}`);
      return false;
    }
    this.docsOnly = sha;
    log.info(`main is at ${sha.slice(0, 7)}: only documentation changed since ${running}, so the Hub stays as it is`);
    return true;
  }

  /** The updater's own clone (made when missing), fetched up to `sha` (once per commit). */
  private async fetchSource(sha: string): Promise<string> {
    const src = path.join(this.opts.paths.work, "src");
    const cloned = existsSync(path.join(src, ".git"));
    if (cloned && this.fetched === sha) return src;
    if (!cloned) {
      await rm(src, { recursive: true, force: true });
      await this.exec("git", ["clone", "--quiet", this.opts.repo, src], { timeoutMs: CLONE_TIMEOUT_MS });
    }
    await this.exec("git", ["fetch", "--quiet", "origin", this.branch], { cwd: src, timeoutMs: CLONE_TIMEOUT_MS });
    this.fetched = sha;
    return src;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return buildEnv(path.join(this.opts.paths.work, "home"));
  }

  /** Check out `sha` in the updater's own clone, test it and package it as `next.tgz`; returns its version. */
  private async build(sha: string): Promise<string> {
    const env = this.buildEnv();
    await mkdir(env.HOME!, { recursive: true });
    const src = await this.fetchSource(sha);
    await this.exec("git", ["checkout", "--quiet", "--force", "--detach", sha], { cwd: src });
    await this.exec("git", ["clean", "-fdxq"], { cwd: src });
    await this.exec("npm", ["ci", "--no-audit", "--no-fund"], { cwd: src, timeoutMs: NPM_CI_TIMEOUT_MS, env });
    await this.exec("npm", ["test"], { cwd: src, timeoutMs: TEST_TIMEOUT_MS, env });
    // Named after the commit, never `-dirty` from a file the build left: a version that didn't
    // match main would be built and installed again on every pass.
    await this.exec("npm", ["run", "package"], { cwd: src, timeoutMs: PACKAGE_TIMEOUT_MS, env: { ...env, ASO_BUILD: sha.slice(0, 7) } });
    const built = await readJsonFile<{ version: string }>(path.join(src, "release", "aso.json"));
    if (!built?.version) throw new Error("npm run package wrote no release/aso.json");
    if (!isBuildOf(built.version, sha)) throw new Error(`the package is ${built.version}, not a build of ${sha.slice(0, 7)}`);
    await copyFile(path.join(src, "release", "aso.tgz"), path.join(this.opts.paths.work, "next.tgz"));
    return built.version;
  }

  private async idle(): Promise<boolean> {
    try {
      const [tasks, projects, plans] = await Promise.all([this.get("/api/tasks"), this.get("/api/projects"), this.get("/api/plans")]);
      return swarmIdle(tasks as Array<{ state: TaskState }>, projects as Array<{ deploy?: { last?: { state: string } } }>, plans as Array<{ state: string }>);
    } catch {
      return false; // the Hub is down or busy: wait
    }
  }

  /** The version the Hub on this machine says it runs, or undefined when it doesn't answer. */
  private async answeringVersion(): Promise<string | undefined> {
    try {
      return ((await this.get("/api/hub/update")) as { current?: string }).current;
    } catch {
      return undefined;
    }
  }

  private async fail(sha: string, error: string, permanent: boolean): Promise<void> {
    log.warn(`update to ${sha.slice(0, 7)}: ${error}`);
    await this.state.markFailed(sha, error, permanent);
    await this.report({ state: "failed", target: sha, error });
  }

  private async get(route: string): Promise<unknown> {
    const res = await fetch(`${this.opts.hubUrl}${route}`, { headers: { authorization: `Bearer ${this.opts.token}` } });
    if (!res.ok) throw new Error(`${route}: ${res.status}`);
    return res.json();
  }

  /** Tell the Hub (which notifies once per outcome); false when it couldn't be reached. */
  private async report(report: Report): Promise<boolean> {
    try {
      const res = await fetch(`${this.opts.hubUrl}/api/hub/update`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...report, ...(report.error ? { error: report.error.slice(0, 2000) } : {}) }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/**
 * The watchdog, run by the version an update replaced: as a timer `CONFIRM_DEADLINE_SEC` after the
 * switch (`id` names the update), and before each start of the service (`atStart`, which also
 * covers a reboot before the timer fired). If the update hasn't confirmed by its deadline, switch
 * back, remember the commit as failed for good and restart (at a start: the start then runs the
 * previous version). Returns whether it rolled back.
 */
export async function rollbackUnconfirmed(paths: UpdatePaths, opts: { id?: string; atStart?: boolean }, restart: () => void): Promise<boolean> {
  const state = new UpdateState(paths.state);
  const pending = await state.pending();
  if (!pending) return false; // confirmed
  if (opts.id && pending.id !== opts.id) return false; // a later update's; its own watchdog decides
  if (opts.atStart && Date.now() < Date.parse(pending.deadline)) return false; // still has time
  const versions = new HubVersions(paths.versions);
  if ((await versions.current()) !== path.resolve(pending.toDir)) {
    await state.clearPending(); // the switch never happened: the version that runs is the one before
    return false;
  }
  const error = `${pending.to} did not come up and answer as itself within ${CONFIRM_DEADLINE_SEC / 60} min, so ${pending.from} was put back`;
  log.warn(error);
  await state.markFailed(pending.target, error, true);
  await state.writeRolledBack({ target: pending.target, error });
  await versions.switchTo(pending.fromDir);
  await state.clearPending();
  if (!opts.atStart) restart();
  return true;
}

async function readJsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
