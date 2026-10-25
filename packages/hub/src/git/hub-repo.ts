import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  createLogger,
  isProtectedPath,
  taskBranchName,
  TaskIdSchema,
  writeDenial,
  type AgentRole,
  type PackageChange,
  type TaskDiff,
  type TaskId,
} from "@aso/shared";
import { parseDiff } from "./diff.js";

const execFileAsync = promisify(execFile);

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
  /** Add all `packages` to package.json + lockfile in `dir`; throw with a readable message on failure. */
  install(dir: string, packages: readonly DependencySpec[]): Promise<void>;
}

export type DependencyResult =
  | { ok: true; changed: boolean; mainCommit: string }
  | { ok: false; reason: string };

export type MergeResult =
  | { ok: true; mainCommit: string }
  | { ok: false; conflict: true; files: string[] }
  | { ok: false; conflict: false; reason: string };

/**
 * A project repository on the Hub (a folder in the projects root). Workers push `task/*`
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

  /** Absolute path of the repository's .git directory. */
  async gitDir(): Promise<string> {
    return (await this.git.raw(["rev-parse", "--absolute-git-dir"])).trim();
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

  /** A file's contents at `commit`, or undefined when it has none. */
  async readFileAt(commit: string, repoPath: string): Promise<string | undefined> {
    if (!(await this.fileExists(commit, repoPath))) return undefined;
    return this.git.raw(["show", `${commit}:${repoPath}`]);
  }

  /**
   * Start a task's branch from main with `files` written, as one commit by the Hub, without
   * touching the checkout (a temporary index). The worker that takes the task continues from it.
   */
  async seedTaskBranch(taskId: TaskId, files: Record<string, string>, message: string): Promise<string> {
    const base = await this.mainHead();
    const gitDir = await this.gitDir();
    const scratch = path.join(gitDir, `aso-seed-${TaskIdSchema.parse(taskId)}`);
    // Plain git: simple-git refuses GIT_INDEX_FILE, and its `env()` would change the shared client.
    const env = { ...process.env, GIT_INDEX_FILE: `${scratch}.index`, GIT_AUTHOR_NAME: "ASO Hub", GIT_AUTHOR_EMAIL: "aso-hub@localhost", GIT_COMMITTER_NAME: "ASO Hub", GIT_COMMITTER_EMAIL: "aso-hub@localhost" };
    const git = { raw: async (args: string[]) => (await execFileAsync("git", args, { cwd: this.dir, env })).stdout };
    try {
      await git.raw(["read-tree", base]);
      for (const [repoPath, content] of Object.entries(files)) {
        await writeFile(scratch, content);
        const blob = (await git.raw(["hash-object", "-w", scratch])).trim();
        await git.raw(["update-index", "--add", "--cacheinfo", `100644,${blob},${repoPath}`]);
      }
      const tree = (await git.raw(["write-tree"])).trim();
      const commit = (await git.raw(["commit-tree", tree, "-p", base, "-m", message])).trim();
      await git.raw(["update-ref", `refs/heads/${taskBranchName(taskId)}`, commit]);
      return commit;
    } finally {
      await rm(scratch, { force: true });
      await rm(`${scratch}.index`, { force: true });
    }
  }

  /** The task branches: task id → the commit its branch points at. */
  async taskBranches(): Promise<Map<string, string>> {
    const out = await this.git.raw(["for-each-ref", "--format=%(refname:strip=3) %(objectname)", "refs/heads/task/"]);
    return new Map(out.split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
  }

  /** Whether `commit` is already part of main. */
  async isInMain(commit: string): Promise<boolean> {
    return this.git.raw(["merge-base", "--is-ancestor", commit, this.mainBranch]).then(
      () => true,
      () => false,
    );
  }

  /**
   * Remove a merged task's branch, if it still points at `commit` (a branch someone moved since
   * stays). Under the main lock, so it never runs at the same time as a merge.
   */
  forgetMergedBranch(taskId: TaskId, commit?: string): Promise<void> {
    const ref = `refs/heads/${taskBranchName(taskId)}`;
    return this.withMainLock(() => this.deleteBranchAt(taskId, commit));
  }

  /** Delete `task/<id>` if it exists (and, with `commit`, still points there); no git command fails. */
  private async deleteBranchAt(taskId: TaskId, commit?: string): Promise<void> {
    const ref = `refs/heads/${taskBranchName(taskId)}`;
    const head = await this.resolve(ref);
    if (!head || (commit && head !== commit)) return;
    await this.git.raw(["update-ref", "-d", ref, head]).catch(() => undefined);
  }

  /** Remove a task's branch (one seeded for a task that couldn't be queued). */
  async deleteTaskBranch(taskId: TaskId): Promise<void> {
    await this.git.raw(["update-ref", "-d", `refs/heads/${taskBranchName(taskId)}`]).catch(() => undefined);
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
      // Its commits are in main now (a merge commit keeps them reachable): the branch only clutters.
      await this.deleteBranchAt(taskId, commit);
      return { ok: true, mainCommit };
    });
  }

  /**
   * Apply a package.json change on main and commit it: add a dependency (via `installer`) or
   * set scripts. A project without package.json gets a minimal one first. Anything else the
   * change touches is rolled back and the request rejected.
   */
  changePackage(change: PackageChange, installer: DependencyInstaller, message: string): Promise<DependencyResult> {
    return this.withMainLock(async () => {
      const notReady = await this.checkoutProblem();
      if (notReady) return { ok: false, reason: notReady };

      const has = (f: string) => existsSync(path.join(this.dir, f));
      const foreign = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].filter(has);
      if (foreign.length) return { ok: false, reason: `only npm projects are supported (found ${foreign.join(", ")})` };

      const before = await this.mainHead();
      try {
        if (!has("package.json")) await this.createManifest();
        if (change.type === "add_dependencies") {
          await installer.install(this.dir, change.packages);
        } else {
          await this.setScripts(change.scripts);
        }
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
      log.info(`committed package change on ${this.mainBranch} @ ${mainCommit.slice(0, 8)}: ${message.split("\n")[0]}`);
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

  /**
   * Move main forward to `ref` (caller holds the main lock). `diverged` when main has commits
   * `ref` lacks, so only a merge can join them.
   */
  async fastForward(ref: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const notReady = await this.checkoutProblem();
    if (notReady) return { ok: false, reason: notReady };
    if (!(await this.isAncestor(this.mainBranch, ref))) {
      // Nothing to do when main already contains ref; otherwise only a merge joins them.
      return (await this.isAncestor(ref, this.mainBranch)) ? { ok: true } : { ok: false, reason: "diverged" };
    }
    await this.git.raw(["merge", "--ff-only", ref]);
    log.info(`${this.mainBranch} fast-forwarded to ${ref} @ ${(await this.mainHead()).slice(0, 8)}`);
    return { ok: true };
  }

  /** Minimal manifest for a project that has none yet (e.g. a brand-new empty repository). */
  private async createManifest(): Promise<void> {
    const name =
      path
        .basename(this.dir)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[._-]+|-+$/g, "") || "project";
    const manifest = { name, version: "0.1.0", private: true };
    await writeFile(path.join(this.dir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    log.info(`created package.json for ${name}`);
  }

  /** Merge scripts into package.json, keeping its indentation and other fields as they are. */
  private async setScripts(scripts: Record<string, string>): Promise<void> {
    const file = path.join(this.dir, "package.json");
    const text = await readFile(file, "utf8");
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("package.json is not valid JSON");
    }
    if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) throw new Error("package.json is not an object");
    const indent = /^\{\n(\s+)"/.exec(text)?.[1] ?? "  ";
    pkg.scripts = { ...((pkg.scripts as Record<string, string>) ?? {}), ...scripts };
    await writeFile(file, JSON.stringify(pkg, null, indent) + "\n");
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

  /** Whether commit `a` is in the history of `b`. */
  /**
   * Whether `a` is in `b`'s history. Not `merge-base --is-ancestor`: it answers by exit code
   * alone, and simple-git resolves a non-zero exit that prints nothing, so "no" read as "yes".
   */
  private async isAncestor(a: string, b: string): Promise<boolean> {
    const [base, commit] = await Promise.all([
      this.git.raw(["merge-base", a, b]).catch(() => ""),
      this.git.raw(["rev-parse", "--verify", "--quiet", `${a}^{commit}`]).catch(() => ""),
    ]);
    return base.trim() !== "" && base.trim() === commit.trim();
  }

  /** What `commit` changes against the main it branched from (their merge base); undefined if the Hub lacks it. */
  async diff(commit: string): Promise<TaskDiff | undefined> {
    const head = await this.resolve(commit);
    if (!head) return undefined;
    const base = (await this.git.raw(["merge-base", `refs/heads/${this.mainBranch}`, head]).catch(() => "")).trim();
    if (!base) return undefined;
    const diff = ["-c", "core.quotePath=false", "diff", "--no-renames", "--no-color", "--no-ext-diff"];
    const [numstat, patch] = await Promise.all([this.git.raw([...diff, "--numstat", "-z", base, head]), this.git.raw([...diff, base, head])]);
    return { base, head, ...parseDiff(numstat, patch) };
  }

  /** `rev-parse --verify` that tolerates simple-git not rejecting on silent non-zero exits. */
  private async resolve(ref: string): Promise<string | undefined> {
    const out = await this.git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
    return out.trim() || undefined;
  }
}
