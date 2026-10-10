import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  createLogger,
  isProtectedPath,
  taskBranchName,
  writeDenial,
  type AgentRole,
  type TaskId,
} from "@aso/shared";

const log = createLogger("hub-repo");

export class HubRepoError extends Error {
  override name = "HubRepoError";
}

/** Files the Hub commits for a dependency change. */
const DEPENDENCY_FILES = ["package.json", "package-lock.json"];

export interface DependencySpec {
  name: string;
  version?: string;
  dev: boolean;
}

export interface DependencyInstaller {
  /** Update package.json + lockfile in `dir`; throw with a readable message on failure. */
  install(dir: string, request: DependencySpec): Promise<void>;
}

export type DependencyResult =
  | { ok: true; changed: boolean; mainCommit: string }
  | { ok: false; reason: string };

export type MergeResult =
  | { ok: true; mainCommit: string }
  | { ok: false; conflict: true; files: string[] }
  | { ok: false; conflict: false; reason: string };

/**
 * The canonical project repository on the Hub (the `--dir` target). Workers push `task/*`
 * branches into it over the Git HTTP endpoint; the Hub merges QA-approved work into main.
 */
export class HubRepository {
  readonly dir: string;
  readonly mainBranch: string;
  private readonly git: SimpleGit;
  private mainLock: Promise<unknown> = Promise.resolve();
  /** Untracked files present before a main-writing operation; left alone by rollbacks. */
  private preexistingUntracked = new Set<string>();

  private constructor(dir: string, mainBranch: string) {
    this.dir = dir;
    this.mainBranch = mainBranch;
    this.git = simpleGit({
      baseDir: dir,
      config: ["user.name=ASO Hub", "user.email=aso-hub@localhost"],
    });
  }

  static async open(dir: string, mainBranch = "main"): Promise<HubRepository> {
    const abs = path.resolve(dir);
    const git = simpleGit({ baseDir: abs });
    const hint =
      `initialise it with: git -C ${abs} init -b ${mainBranch} && ` +
      `git -C ${abs} commit --allow-empty -m "Initial commit"`;

    const top = await git.raw(["rev-parse", "--show-toplevel"]).catch(() => "");
    if (!top.trim()) throw new HubRepoError(`${abs} is not a git repository; ${hint}`);
    if (path.resolve(top.trim()) !== abs) {
      throw new HubRepoError(`${abs} is inside the repository ${top.trim()}; pass the repository root`);
    }
    const repo = new HubRepository(abs, mainBranch);
    if (!(await repo.resolve(`refs/heads/${mainBranch}`))) {
      throw new HubRepoError(`${abs} has no "${mainBranch}" branch with commits; ${hint}`);
    }
    return repo;
  }

  async mainHead(): Promise<string> {
    return (await this.resolve(`refs/heads/${this.mainBranch}`)) ?? "";
  }

  /**
   * Check a worker's claimed result before spending QA time on it. Returns an error message,
   * or undefined if the commit is the head of `task/<id>` and leaves protected files alone.
   */
  async verifyTaskCommit(taskId: TaskId, commit: string, role?: AgentRole): Promise<string | undefined> {
    const branch = taskBranchName(taskId);
    const head = await this.resolve(`refs/heads/${branch}`);
    if (!head) return `${branch} was not pushed to the Hub`;
    if (head !== commit) return `${branch} is at ${head.slice(0, 8)}, not the reported ${commit.slice(0, 8)}`;

    const changed = await this.git.raw(["diff", "--name-only", "--no-renames", `${this.mainBranch}...${commit}`]);
    const files = changed.split("\n").filter(Boolean);
    if (files.length === 0) return `${branch} has no changes relative to ${this.mainBranch}`;
    const blocked = files.filter(isProtectedPath);
    if (blocked.length) return `${branch} modifies protected files: ${blocked.join(", ")}`;
    if (role) {
      const outOfScope = files.filter((f) => writeDenial(role, f));
      if (outOfScope.length) return `${branch} modifies files outside the ${role} role's scope: ${outOfScope.join(", ")}`;
    }
    return undefined;
  }

  async fileExists(commit: string, repoPath: string): Promise<boolean> {
    const out = await this.git.raw(["ls-tree", "--name-only", commit, "--", repoPath]).catch(() => "");
    return out.trim().length > 0;
  }

  /** Merge a tested commit into main (no fast-forward, so every task is one merge commit). */
  merge(taskId: TaskId, commit: string, message: string): Promise<MergeResult> {
    return this.withMainLock(async () => {
      const notReady = await this.checkoutProblem();
      if (notReady) return { ok: false, conflict: false, reason: notReady };

      const error = await this.git.raw(["merge", "--no-ff", "-m", message, commit]).then(
        () => undefined,
        (err: Error) => err,
      );
      const conflicted = (await this.git.status()).conflicted;
      if (error || conflicted.length) {
        await this.git.raw(["merge", "--abort"]).catch(() => undefined);
        if (conflicted.length) return { ok: false, conflict: true, files: conflicted };
        return { ok: false, conflict: false, reason: error!.message.trim() };
      }
      const mainCommit = await this.mainHead();
      log.info(`merged ${taskBranchName(taskId)} into ${this.mainBranch} @ ${mainCommit.slice(0, 8)}`);
      return { ok: true, mainCommit };
    });
  }

  /**
   * Run `installer` in the checkout and commit the resulting manifest + lockfile change to main.
   * Anything else the installer touches is rolled back and the request rejected.
   */
  addDependency(
    request: DependencySpec,
    installer: DependencyInstaller,
    message: string,
  ): Promise<DependencyResult> {
    return this.withMainLock(async () => {
      const notReady = await this.checkoutProblem();
      if (notReady) return { ok: false, reason: notReady };

      const has = (f: string) => existsSync(path.join(this.dir, f));
      if (!has("package.json")) return { ok: false, reason: "the target project has no package.json" };
      const foreign = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].filter(has);
      if (foreign.length) return { ok: false, reason: `only npm projects are supported (found ${foreign.join(", ")})` };

      const before = await this.mainHead();
      try {
        await installer.install(this.dir, request);
      } catch (err) {
        await this.restoreManifests();
        return { ok: false, reason: (err as Error).message };
      }

      const changed = (await this.git.status()).files.map((f) => f.path);
      const unexpected = changed.filter((f) => !DEPENDENCY_FILES.includes(f) && !this.preexistingUntracked.has(f));
      if (unexpected.length) {
        await this.restoreManifests(unexpected);
        return { ok: false, reason: `installer modified unexpected files: ${unexpected.join(", ")}` };
      }
      const toCommit = changed.filter((f) => DEPENDENCY_FILES.includes(f));
      if (toCommit.length === 0) return { ok: true, changed: false, mainCommit: before };

      await this.git.add(toCommit);
      await this.git.commit(message, toCommit);
      const mainCommit = await this.mainHead();
      log.info(`committed dependency change on ${this.mainBranch} @ ${mainCommit.slice(0, 8)}: ${message}`);
      return { ok: true, changed: true, mainCommit };
    });
  }

  /**
   * Merge the remote's main into ours (caller holds the main lock). Used when a push is
   * rejected because someone pushed to the remote directly.
   */
  async mergeRemoteMain(remote: string, git: SimpleGit): Promise<{ ok: true } | { ok: false; reason: string; conflict: boolean }> {
    const notReady = await this.checkoutProblem();
    if (notReady) return { ok: false, reason: notReady, conflict: false };
    try {
      await git.fetch(remote, this.mainBranch);
    } catch (err) {
      return { ok: false, reason: `fetch from ${remote} failed: ${(err as Error).message.split("\n")[0]}`, conflict: false };
    }
    const error = await this.git
      .raw(["merge", "--no-ff", "-m", `Merge ${remote}/${this.mainBranch} into ${this.mainBranch}`, `${remote}/${this.mainBranch}`])
      .then(() => undefined, (err: Error) => err);
    const conflicted = (await this.git.status()).conflicted;
    if (error || conflicted.length) {
      await this.git.raw(["merge", "--abort"]).catch(() => undefined);
      return conflicted.length
        ? { ok: false, conflict: true, reason: `${remote}/${this.mainBranch} conflicts with ${this.mainBranch} in ${conflicted.join(", ")}; resolve it in the Hub checkout, then retry` }
        : { ok: false, conflict: false, reason: error!.message.trim() };
    }
    return { ok: true };
  }

  /** Why main can't be written right now, or undefined if the checkout is clean and on main. */
  private async checkoutProblem(): Promise<string | undefined> {
    const current = (await this.git.raw(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
    if (current !== this.mainBranch) {
      return `the Hub checkout is on "${current || "detached HEAD"}", not ${this.mainBranch}`;
    }
    const status = await this.git.status();
    this.preexistingUntracked = new Set(status.not_added);
    const dirty = status.files.filter((f) => f.index !== "?" || f.working_dir !== "?");
    if (dirty.length) return `the Hub checkout has uncommitted changes: ${dirty.map((f) => f.path).join(", ")}`;
    return undefined;
  }

  /** Undo installer side effects: tracked files back to HEAD, new files removed. */
  private async restoreManifests(extra: string[] = []): Promise<void> {
    const status = await this.git.status();
    const created = new Set(status.not_added.filter((f) => !this.preexistingUntracked.has(f)));
    const paths = [...new Set([...DEPENDENCY_FILES, ...extra])];
    const tracked = paths.filter((f) => !created.has(f) && status.files.some((s) => s.path === f));
    if (tracked.length) await this.git.raw(["checkout", "HEAD", "--", ...tracked]);
    for (const f of created) await rm(path.join(this.dir, f), { recursive: true, force: true });
  }

  /** Serialises everything that writes to main (merges now, dependency installs in Phase 4). */
  withMainLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mainLock.then(fn, fn);
    this.mainLock = run.catch(() => undefined);
    return run;
  }

  /** `rev-parse --verify` that tolerates simple-git not rejecting on silent non-zero exits. */
  private async resolve(ref: string): Promise<string | undefined> {
    const out = await this.git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
    return out.trim() || undefined;
  }
}
