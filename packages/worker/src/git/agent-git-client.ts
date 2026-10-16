import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import {
  CommitShaSchema,
  TaskIdSchema,
  createLogger,
  isProtectedPath,
  taskBranchName,
  type TaskId,
} from "@aso/shared";

const log = createLogger("git");

export class AgentGitError extends Error {
  override name = "AgentGitError";
}

export class ProtectedFileError extends AgentGitError {
  override name = "ProtectedFileError";
  constructor(readonly files: string[]) {
    super(
      `task branches may not modify dependency manifests or lockfiles: ${files.join(", ")}. ` +
        "Use requestDependencies() instead.",
    );
  }
}

export class RebaseConflictError extends AgentGitError {
  override name = "RebaseConflictError";
  constructor(
    readonly files: string[],
    readonly stage: "rebase" | "restore",
  ) {
    super(
      stage === "rebase"
        ? `rebase onto main conflicted (aborted, branch unchanged): ${files.join(", ")}`
        : `rebased onto main, but uncommitted edits conflict with it: ${files.join(", ")}. ` +
            "Conflict markers are in the working tree; the original edits remain in `git stash`.",
    );
  }
}

export interface AgentGitClientOptions {
  remote?: string;
  mainBranch?: string;
  /** Identity used for agent commits. */
  author?: { name: string; email: string };
  /** ASO token for the Hub's Git endpoint; sent as a header per command, never stored in .git/config. */
  token?: string;
}

function gitConfig(opts: AgentGitClientOptions): string[] {
  const author = opts.author ?? { name: "ASO Agent", email: "aso-agent@localhost" };
  const config = [`user.name=${author.name}`, `user.email=${author.email}`];
  if (opts.token) config.push(`http.extraHeader=Authorization: Bearer ${opts.token}`);
  return config;
}

export interface CompletedTask {
  taskId: TaskId;
  branch: string;
  commit: string;
  files: string[];
}

/**
 * The only way agents interact with Git. Agents edit files directly; branch management,
 * commits, pushes and rebases go through this class so the Git flow stays enforced.
 */
export class AgentGitClient {
  readonly repoDir: string;
  readonly remote: string;
  readonly mainBranch: string;
  private readonly git: SimpleGit;
  private activeTask: TaskId | undefined;

  constructor(repoDir: string, opts: AgentGitClientOptions = {}) {
    this.repoDir = path.resolve(repoDir);
    this.remote = opts.remote ?? "origin";
    this.mainBranch = opts.mainBranch ?? "main";
    this.git = simpleGit({ baseDir: this.repoDir, config: gitConfig(opts) });
  }

  /** Open an existing checkout, or clone `remoteUrl` into `repoDir` first. */
  static async cloneOrOpen(
    repoDir: string,
    remoteUrl: string,
    opts: AgentGitClientOptions = {},
  ): Promise<AgentGitClient> {
    const dir = path.resolve(repoDir);
    const remote = opts.remote ?? "origin";
    if (!existsSync(path.join(dir, ".git"))) {
      log.info(`cloning ${remoteUrl} into ${dir}`);
      await simpleGit({ config: gitConfig(opts) }).clone(remoteUrl, dir, ["--origin", remote]);
    } else {
      // The Hub may have moved (new IP/port) since the checkout was created.
      const git = simpleGit({ baseDir: dir });
      const current = (await git.remote(["get-url", remote]).catch(() => ""))?.toString().trim();
      if (current !== remoteUrl) await git.remote(["set-url", remote, remoteUrl]);
    }
    await excludeLocally(dir, LOCAL_EXCLUDES);
    return new AgentGitClient(dir, opts);
  }

  get currentTask(): TaskId | undefined {
    return this.activeTask;
  }

  /**
   * Check out `task/<id>`. Resumes the remote task branch if it exists (e.g. rework after
   * QA feedback), otherwise branches from the latest remote main.
   */
  async startTask(taskId: TaskId): Promise<{ branch: string; base: string; resumed: boolean }> {
    const id = TaskIdSchema.parse(taskId);
    const branch = taskBranchName(id);

    const status = await this.git.status();
    if (!status.isClean()) {
      throw new AgentGitError(
        `cannot start ${branch}: working tree has uncommitted changes (${status.files.map((f) => f.path).join(", ")})`,
      );
    }

    await this.git.fetch([this.remote, "--prune"]);
    const remoteBranch = `${this.remote}/${branch}`;
    const resumed = await this.refExists(`refs/remotes/${remoteBranch}`);
    const start = resumed ? remoteBranch : `${this.remote}/${this.mainBranch}`;

    await this.git.raw(["checkout", "-B", branch, start]);
    this.activeTask = id;
    const base = await this.head();
    log.info(`started ${branch} from ${start} (${base.slice(0, 8)})`);
    return { branch, base, resumed };
  }

  /** Stage all changes, commit, and push `task/<id>` to the Hub. */
  async completeTask(commitMessage: string): Promise<CompletedTask> {
    const taskId = await this.requireTaskBranch();
    const branch = taskBranchName(taskId);
    const message = commitMessage.trim();
    if (!message) throw new AgentGitError("commit message must not be empty");

    const status = await this.git.status();
    const working = new Set(status.files.map((f) => f.path));
    for (const r of status.renamed) working.add(r.from);
    const committed = await this.changedSinceMain();

    const touched = [...new Set([...working, ...committed])].sort();
    const blocked = touched.filter(isProtectedPath);
    if (blocked.length) throw new ProtectedFileError(blocked);
    if (touched.length === 0) throw new AgentGitError(`nothing to commit on ${branch}`);

    if (working.size) {
      await this.git.add(["-A"]);
      await this.git.commit(message);
    }
    // The branch is owned by this worker; lease protects against clobbering anything unexpected
    // while still allowing pushes after syncWithMain() rewrote the branch.
    await this.git.push(this.remote, branch, ["--set-upstream", "--force-with-lease"]);

    const commit = await this.head();
    this.activeTask = undefined;
    log.info(`pushed ${branch} @ ${commit.slice(0, 8)} (${touched.length} files)`);
    return { taskId, branch, commit, files: touched };
  }

  /**
   * Rebase the task branch onto the latest remote main (e.g. after the Hub committed a new
   * dependency). Uncommitted edits are stashed and restored around the rebase.
   */
  async syncWithMain(): Promise<{ head: string }> {
    await this.requireTaskBranch();
    const target = `${this.remote}/${this.mainBranch}`;
    await this.git.fetch(this.remote, this.mainBranch);

    const dirty = !(await this.git.status()).isClean();
    if (dirty) await this.git.stash(["push", "--include-untracked", "-m", "aso: syncWithMain"]);

    const rebaseError = await this.git.rebase([target]).then(
      () => undefined,
      (err: unknown) => err,
    );
    const rebaseConflicts = (await this.git.status()).conflicted;
    if (rebaseError || rebaseConflicts.length) {
      await this.git.rebase(["--abort"]).catch(() => undefined);
      if (dirty) await this.git.stash(["pop"]);
      if (rebaseConflicts.length) throw new RebaseConflictError(rebaseConflicts, "rebase");
      throw rebaseError;
    }

    if (dirty) {
      // A conflicting pop is not always reported as an error, so inspect the tree either way.
      const popError = await this.git.stash(["pop"]).then(
        () => undefined,
        (err: unknown) => err,
      );
      const conflicted = (await this.git.status()).conflicted;
      if (conflicted.length) throw new RebaseConflictError(conflicted, "restore");
      if (popError) throw popError;
    }

    const head = await this.head();
    log.info(`rebased onto ${target} (${head.slice(0, 8)})`);
    return { head };
  }

  /**
   * Throw away local state left by a previous job (crash, failed task, aborted rebase).
   * Safe because pushed branches on the Hub are the source of truth. Ignored files such as
   * node_modules are kept.
   */
  async discardLocalChanges(): Promise<void> {
    await this.git.raw(["rebase", "--abort"]).catch(() => undefined);
    await this.git.raw(["merge", "--abort"]).catch(() => undefined);
    await this.git.raw(["reset", "--hard", "--quiet"]);
    await this.git.raw(["clean", "-fd", "--quiet"]);
    this.activeTask = undefined;
  }

  /** Detached checkout of the latest remote main (read-only use, e.g. the Architect exploring). */
  async checkoutMain(): Promise<string> {
    await this.git.fetch([this.remote, "--prune"]);
    await this.git.raw(["checkout", "--quiet", "--detach", `${this.remote}/${this.mainBranch}`]);
    this.activeTask = undefined;
    return this.head();
  }

  /** Detached checkout of a commit on `task/<id>`, for QA runs. */
  async checkoutCommit(taskId: TaskId, commit: string): Promise<void> {
    const branch = taskBranchName(TaskIdSchema.parse(taskId));
    const sha = CommitShaSchema.parse(commit);
    await this.git.fetch([this.remote, "--prune"]);
    const remoteBranch = `${this.remote}/${branch}`;
    if (!(await this.refExists(`refs/remotes/${remoteBranch}`))) {
      throw new AgentGitError(`${branch} does not exist on the Hub`);
    }
    const base = (await this.git.raw(["merge-base", sha, remoteBranch]).catch(() => "")).trim();
    if (base !== sha) throw new AgentGitError(`${sha.slice(0, 8)} is not on ${branch}`);
    await this.git.raw(["checkout", "--quiet", "--detach", sha]);
    this.activeTask = undefined;
    log.info(`checked out ${branch} @ ${sha.slice(0, 8)} for testing`);
  }

  private async requireTaskBranch(): Promise<TaskId> {
    if (!this.activeTask) throw new AgentGitError("no active task; call startTask() first");
    const current = (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
    const expected = taskBranchName(this.activeTask);
    if (current !== expected) {
      throw new AgentGitError(`expected to be on ${expected} but HEAD is ${current}`);
    }
    return this.activeTask;
  }

  /** Files changed by commits on this branch that are not on remote main. */
  private async changedSinceMain(): Promise<string[]> {
    const out = await this.git.raw([
      "diff",
      "--name-only",
      "--no-renames",
      `${this.remote}/${this.mainBranch}...HEAD`,
    ]);
    return out.split("\n").filter(Boolean);
  }

  private async refExists(ref: string): Promise<boolean> {
    // simple-git does not reject on a non-zero exit with empty stderr, so check the output.
    const out = await this.git.raw(["rev-parse", "--verify", "--quiet", ref]).catch(() => "");
    return out.trim().length > 0;
  }

  private async head(): Promise<string> {
    return (await this.git.revparse(["HEAD"])).trim();
  }
}

/**
 * What the worker puts in a checkout that must never be committed, whatever the project's
 * .gitignore says (a new project may have none): `git add -A` commits everything else.
 */
export const LOCAL_EXCLUDES = ["node_modules/"];

/** Add patterns to the checkout's own .git/info/exclude (never committed), once. */
export async function excludeLocally(repoDir: string, patterns: readonly string[]): Promise<void> {
  const file = path.join(repoDir, ".git", "info", "exclude");
  const lines = new Set((await readFile(file, "utf8").catch(() => "")).split("\n").map((l) => l.trim()));
  const missing = patterns.filter((p) => !lines.has(p));
  if (!missing.length) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${lines.size > 1 ? "\n" : ""}# added by the ASO worker\n${missing.join("\n")}\n`);
}
