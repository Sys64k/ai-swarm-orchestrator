import { createLogger, taskBranchName, type ChecksOverall, type CheckState, type ReviewChecks } from "@aso/shared";
import type { ReviewGate, ReviewOutcome, TaskManager, TaskRecord } from "../tasks.js";
import {
  GitHubApi,
  GitHubError,
  parseGitHubRemote,
  type CheckRun,
  type CommitStatus,
  type PullRef,
  type PullState,
  type RepoSlug,
  type Review,
  type ReviewComment,
} from "./github.js";
import type { GitSync } from "./sync.js";

const log = createLogger("pull-requests");

export interface PullRequestOptions {
  /** Off: QA-approved work is merged on the Hub and main pushed, as without a GitHub token. Default on. */
  enabled?: boolean;
  /** GitHub token with Contents and Pull requests read/write on the repository. */
  token?: string;
  /** GitHub API base (tests point it at a fake). */
  apiUrl?: string;
  /** The repository, when the remote is not a github.com URL (tests). */
  repo?: RepoSlug;
  /** How often open pull requests are checked. */
  pollMs?: number;
  /** The console's address, for links from a pull request to its task (e.g. its screenshots). */
  consoleUrl?: string;
}

export interface PullRequestStatus {
  enabled: boolean;
  /** `owner/repo` on GitHub. */
  repo?: string;
  /** Why work is merged on the Hub instead. */
  reason?: string;
}

const DEFAULT_POLL_MS = 30_000;
/** Limits of a rework's reason and output in the protocol (TASK_ASSIGNMENT). */
const REASON_MAX = 4000;
const OUTPUT_MAX = 100_000;

/**
 * QA-approved work as GitHub pull requests that a person merges. The Hub pushes the task's
 * branch, opens the PR, and checks it every `pollMs`: merged, closed, changes requested on the
 * current commit, or conflicting with main. A merge brings the Hub's main up to GitHub's.
 */
export class PullRequests implements ReviewGate {
  private timer?: NodeJS.Timeout;
  private checking = false;

  private constructor(
    private readonly api: GitHubApi,
    private readonly sync: GitSync,
    private readonly mainBranch: string,
    private readonly pollMs: number,
    private readonly consoleUrl?: string,
  ) {}

  /** Pull requests for this project (`gate`), or why work is merged on the Hub instead; `status` says which. */
  static async create(sync: GitSync, mainBranch: string, opts: PullRequestOptions): Promise<{ gate?: PullRequests; status: PullRequestStatus }> {
    const off = (reason: string) => ({ status: { enabled: false, reason } });
    if (opts.enabled === false) return off("pull requests are off (ASO_PULL_REQUESTS=0)");
    if (!sync.status().enabled) return off(sync.status().reason ?? "pushing is off");
    const url = await sync.remoteUrl();
    const slug = opts.repo ?? (url ? parseGitHubRemote(url) : undefined);
    if (!slug) return off(`${sync.status().remote} is not a GitHub repository`);
    if (!opts.token) return off("no GitHub token (ASO_GIT_TOKEN) for opening pull requests");
    const gate = new PullRequests(new GitHubApi(slug, opts.token, opts.apiUrl), sync, mainBranch, opts.pollMs ?? DEFAULT_POLL_MS, opts.consoleUrl);
    return { gate, status: { enabled: true, repo: `${slug.owner}/${slug.repo}` } };
  }

  /** Check `tasks`' pull requests every `pollMs` until `stopPolling`. */
  startPolling(tasks: TaskManager): void {
    this.timer = setInterval(() => void this.check(tasks), this.pollMs);
    this.timer.unref();
  }

  stopPolling(): void {
    clearInterval(this.timer);
  }

  async open(task: TaskRecord): Promise<PullRef> {
    const branch = taskBranchName(task.spec.taskId);
    await this.sync.pushBranch(branch);
    const body = pullRequestBody(task, this.consoleUrl);
    const existing = task.review?.pr ?? (await this.api.findOpenPull(branch));
    if (existing && (await this.api.getPull(existing.number)).state === "open") {
      await this.api.updatePull(existing.number, { body });
      await this.api.comment(existing.number, `New commit \`${task.commit?.slice(0, 8)}\` passed QA: ${task.qaSummary ?? "no summary"}. Ready for review again.`);
      return existing;
    }
    const pr = await this.api.createPull({ title: task.spec.title, head: branch, base: this.mainBranch, body });
    log.info(`opened pull request #${pr.number} for ${task.spec.taskId}: ${pr.url}`);
    return pr;
  }

  async checks(task: TaskRecord): Promise<ReviewChecks> {
    const pr = pullOf(task);
    const pull = await this.api.getPull(pr.number);
    const [runs, statuses] = await Promise.allSettled([this.checkRuns(pull.headSha), this.api.statuses(pull.headSha)]);
    const read = <T>(r: PromiseSettledResult<T[]>) => (r.status === "fulfilled" ? r.value : (r.reason as Error));
    return { pr, headSha: pull.headSha, mergeable: pull.mergeable, ...summarizeChecks(read(runs), read(statuses)) };
  }

  /** Check runs, or with a fine-grained token (no Checks permission there) the Actions jobs. */
  private async checkRuns(sha: string): Promise<CheckRun[]> {
    try {
      return await this.api.checkRuns(sha);
    } catch (err) {
      if (!(err instanceof GitHubError) || (err.status !== 403 && err.status !== 404)) throw err;
      return this.api.actionJobs(sha);
    }
  }

  /** Merge the pull request at the commit QA passed, and bring the Hub's main up to GitHub's. */
  async merge(task: TaskRecord): Promise<string> {
    const pr = pullOf(task);
    const mainCommit = await this.api.mergePull(pr.number, task.commit!);
    log.info(`merged pull request #${pr.number} for ${task.spec.taskId} from ASO`);
    await this.catchUp(`pull request #${pr.number} was merged`);
    return mainCommit;
  }

  async noteChangesRequested(task: TaskRecord, message: string): Promise<void> {
    const pr = pullOf(task);
    const quoted = message.split("\n").map((l) => `> ${l}`).join("\n");
    await this.api.comment(pr.number, `**Changes requested in ASO:**\n\n${quoted}\n\nThe task went back to an agent; its next commit comes to this pull request.`);
  }

  async close(task: TaskRecord, comment: string): Promise<void> {
    const pr = task.review?.pr;
    if (!pr) return;
    await this.api.comment(pr.number, comment);
    await this.api.updatePull(pr.number, { state: "closed" });
  }

  /**
   * One pass over the tasks waiting for review: open the pull requests that failed to open,
   * and act on what happened to the others. Overlapping passes are skipped.
   */
  async check(tasks: TaskManager): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const task of tasks.list()) {
        if (task.state !== "awaiting_review") continue;
        if (!task.review?.pr) {
          await tasks.openReview(task);
          continue;
        }
        try {
          const outcome = await this.outcome(task, task.review.pr);
          if (outcome) tasks.applyReview(task.spec.taskId, outcome);
        } catch (err) {
          tasks.reviewCheckFailed(task.spec.taskId, (err as Error).message);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  /** What happened to the pull request since the last check, if anything to act on. */
  private async outcome(task: TaskRecord, pr: PullRef): Promise<ReviewOutcome | undefined> {
    const pull = await this.api.getPull(pr.number);
    if (pull.merged) {
      // Dependants branch from the Hub's main: it must have the merge before they start.
      await this.catchUp("merged on GitHub");
      return { kind: "merged", mainCommit: pull.mergeCommit ?? pull.headSha };
    }
    if (pull.state === "closed") return { kind: "closed" };

    const review = changesRequested(await this.api.reviews(pr.number), pull, task.review?.handled ?? []);
    if (review) {
      const comments = await this.api.reviewComments(pr.number, review.id);
      return { kind: "changes_requested", reviewId: review.id, author: review.author, ...reviewFeedback(review, comments) };
    }
    if (pull.mergeable === false) {
      // The agent rebases onto the Hub's main, so it needs what GitHub's main gained since.
      await this.catchUp("the pull request conflicts with main");
      return { kind: "conflict" };
    }
    return undefined;
  }

  /** Bring the Hub's main up to GitHub's, or throw saying what it was for. */
  private async catchUp(why: string): Promise<void> {
    const result = await this.sync.catchUp();
    if (!result.ok) throw new Error(`${why}, but the Hub's main could not catch up: ${result.reason}`);
  }
}

function pullOf(task: TaskRecord): PullRef {
  const pr = task.review?.pr;
  if (!pr) throw new Error(`task ${task.spec.taskId} has no pull request yet`);
  return pr;
}

/** A check run's or commit status's outcome, in the four states the console shows. */
export function checkState(check: { status?: string; conclusion?: string | null; state?: string }): CheckState {
  if (check.state !== undefined) return check.state === "success" ? "passing" : check.state === "pending" ? "pending" : "failing";
  if (check.status !== "completed") return "pending";
  if (check.conclusion === "success") return "passing";
  if (check.conclusion === "neutral" || check.conclusion === "skipped") return "skipped";
  return "failing"; // failure, cancelled, timed_out, action_required, stale...
}

/**
 * A pull request's checks: check runs (GitHub Actions) and commit statuses, each a list or
 * the error reading it. Anything failing makes it failing; otherwise anything unreadable
 * makes it unknown, so a merge never goes ahead on checks nobody could see.
 */
export function summarizeChecks(runs: CheckRun[] | Error, statuses: CommitStatus[] | Error): { overall: ChecksOverall; checks: ReviewChecks["checks"]; error?: string } {
  const checks = [
    ...(Array.isArray(runs) ? runs.map((r) => ({ name: r.name, state: checkState(r), url: r.url })) : []),
    ...(Array.isArray(statuses) ? statuses.map((s) => ({ name: s.context, state: checkState({ state: s.state }), url: s.url })) : []),
  ];
  const errors = [runs, statuses].filter((r): r is Error => r instanceof Error);
  const error = errors.length ? checksError(errors[0]) : undefined;
  const has = (state: CheckState) => checks.some((c) => c.state === state);
  const overall: ChecksOverall = has("failing") ? "failing" : error ? "unknown" : has("pending") ? "pending" : has("passing") ? "passing" : "none";
  return { overall, checks, ...(error ? { error } : {}) };
}

/**
 * Why a pull request may not be merged with these checks, or undefined if it may. Its head must
 * be the commit QA passed and it must not conflict; unless `force`, its checks must pass (or
 * there are none). The console's approveAction mirrors this.
 */
export function mergeBlock(checks: ReviewChecks, testedCommit: string | undefined, force = false): string | undefined {
  const n = checks.pr.number;
  if (checks.headSha !== testedCommit) return `pull request #${n} has a commit QA did not test; wait for the Hub to update it`;
  if (checks.mergeable === false) return `pull request #${n} conflicts with main; the Hub sends it back to an agent at its next check`;
  if (force || checks.overall === "passing" || checks.overall === "none") return undefined;
  if (checks.overall === "unknown") return `checks can't be read (${checks.error}); approve with force to merge anyway`;
  const names = checks.checks.filter((c) => c.state === checks.overall).map((c) => c.name);
  return `checks ${checks.overall}${names.length ? `: ${names.join(", ")}` : ""}; approve with force to merge anyway`;
}

function checksError(err: Error): string {
  if (err instanceof GitHubError && (err.status === 403 || err.status === 404)) {
    return "the GitHub token can't read this repository's checks: give it read access to Actions and Commit statuses";
  }
  return err.message;
}

/**
 * The review to act on: the newest decisive one (approve or request changes) on the pull
 * request's current commit, if it asks for changes and was not handled yet. A review of an
 * older commit was answered by the commits since.
 *
 * GitHub lets no one request changes on (or approve) their own pull request, and the Hub opens
 * them with its token's owner, usually the person reviewing. On their own PR the review form
 * only offers Comment, so a submitted Comment review by the PR's author asks for changes too.
 */
export function changesRequested(reviews: readonly Review[], pull: Pick<PullState, "headSha" | "author">, handled: readonly number[]): Review | undefined {
  const asksChanges = (r: Review) => r.state === "CHANGES_REQUESTED" || (r.state === "COMMENTED" && r.author === pull.author);
  const decisive = reviews.filter((r) => r.commit === pull.headSha && (asksChanges(r) || r.state === "APPROVED"));
  const latest = decisive.reduce<Review | undefined>((a, r) => (!a || r.id > a.id ? r : a), undefined);
  return latest && asksChanges(latest) && !handled.includes(latest.id) ? latest : undefined;
}

/** A review as rework for the agent: a short reason, and everything the reviewer wrote. */
export function reviewFeedback(review: Review, comments: readonly ReviewComment[]): { summary: string; details: string } {
  const body = review.body.trim();
  const lines = comments.map((c) => `- ${c.path}${c.line ? `:${c.line}` : ""}: ${c.body.trim()}`);
  const summary = `${review.author} asked for changes on GitHub: ${body || "see the comments on the code"}`;
  const details = [`Review by ${review.author}:`, body || "(no summary)", ...(lines.length ? ["", "Comments on the code:", ...lines] : [])].join("\n");
  return { summary: summary.length > REASON_MAX ? `${summary.slice(0, REASON_MAX - 1)}…` : summary, details: details.slice(0, OUTPUT_MAX) };
}

/** What the pull request says about the task: what was asked, what QA found, what it cost. */
export function pullRequestBody(task: TaskRecord, consoleUrl?: string): string {
  const s = task.spec;
  const criteria = s.acceptanceCriteria.length ? ["", "**Acceptance criteria**", ...s.acceptanceCriteria.map((c) => `- ${c}`)] : [];
  const files = task.filesTouched.length ? ["", `**Files** (${task.filesTouched.length})`, ...task.filesTouched.slice(-30).map((f) => `- \`${f}\``)] : [];
  const rounds = roundsNote(task);
  return [
    s.description.trim(),
    ...criteria,
    ...files,
    "",
    `**QA:** ${task.qaSummary ?? "not run"}`,
    ...screenshotsNote(task, consoleUrl),
    `**Task:** \`${s.taskId}\` (${s.role}, ${s.kind})${rounds ? `, after ${rounds}` : ""}; model cost about $${task.llm.costUsd.toFixed(2)}`,
    "",
    "---",
    "Opened by the ASO Hub. **Merge** (here or in the ASO console) to accept it. To send it back to an agent, submit a review that **requests changes** (on a pull request you opened yourself, GitHub only offers **Comment**: that works too). **Close** to cancel the task.",
  ].join("\n");
}

/** Where to see the screenshots QA took; GitHub can't show them, as they stay on the Hub. */
function screenshotsNote(task: Pick<TaskRecord, "spec" | "screenshots">, consoleUrl?: string): string[] {
  const files = task.screenshots?.files ?? [];
  if (!files.length) return [];
  const names = files.map((f) => `\`${f.name}\``).join(", ");
  const where = consoleUrl
    ? `[see them in the ASO console](${consoleUrl.replace(/\/+$/, "")}/tasks/${encodeURIComponent(task.spec.taskId)})`
    : "see them on the task in the ASO console";
  return [`**Screenshots** (${files.length}): ${names}; ${where}`];
}

/** "2 rework rounds and 1 review round", or empty when the work never came back. */
function roundsNote(task: Pick<TaskRecord, "reworkRound" | "review">): string {
  const count = (n: number, what: string) => (n ? `${n} ${what} round${n === 1 ? "" : "s"}` : "");
  return [count(task.reworkRound, "rework"), count(task.review?.rounds ?? 0, "review")].filter(Boolean).join(" and ");
}
