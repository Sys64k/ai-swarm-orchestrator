import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { createLogger, isProtectedPath, taskBranchName, type TaskId } from "@aso/shared";

const log = createLogger("hub-repo");

export class HubRepoError extends Error {
  override name = "HubRepoError";
}

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
  async verifyTaskCommit(taskId: TaskId, commit: string): Promise<string | undefined> {
    const branch = taskBranchName(taskId);
    const head = await this.resolve(`refs/heads/${branch}`);
    if (!head) return `${branch} was not pushed to the Hub`;
    if (head !== commit) return `${branch} is at ${head.slice(0, 8)}, not the reported ${commit.slice(0, 8)}`;

    const changed = await this.git.raw(["diff", "--name-only", "--no-renames", `${this.mainBranch}...${commit}`]);
    const files = changed.split("\n").filter(Boolean);
    if (files.length === 0) return `${branch} has no changes relative to ${this.mainBranch}`;
    const blocked = files.filter(isProtectedPath);
    if (blocked.length) return `${branch} modifies protected files: ${blocked.join(", ")}`;
    return undefined;
  }

  async fileExists(commit: string, repoPath: string): Promise<boolean> {
    const out = await this.git.raw(["ls-tree", "--name-only", commit, "--", repoPath]).catch(() => "");
    return out.trim().length > 0;
  }

  /** Merge a tested commit into main (no fast-forward, so every task is one merge commit). */
  merge(taskId: TaskId, commit: string, message: string): Promise<MergeResult> {
    return this.withMainLock(async () => {
      const current = (await this.git.raw(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
      if (current !== this.mainBranch) {
        return { ok: false, conflict: false, reason: `the Hub checkout is on "${current || "detached HEAD"}", not ${this.mainBranch}` };
      }
      const status = await this.git.status();
      const dirty = status.files.filter((f) => f.index !== "?" || f.working_dir !== "?");
      if (dirty.length) {
        return {
          ok: false,
          conflict: false,
          reason: `the Hub checkout has uncommitted changes: ${dirty.map((f) => f.path).join(", ")}`,
        };
      }

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
