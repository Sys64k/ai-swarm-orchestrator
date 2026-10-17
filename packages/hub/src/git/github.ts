/**
 * The few GitHub REST calls the Hub's pull-request flow needs. Plain fetch, no SDK: open and
 * update a task's PR, read its state, reviews and checks, comment, merge, close.
 */

export const GITHUB_API = "https://api.github.com";

export interface RepoSlug {
  owner: string;
  repo: string;
}

/** `owner/repo` of a github.com remote (HTTPS or SSH), or undefined for any other host. */
export function parseGitHubRemote(url: string): RepoSlug | undefined {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PullRef {
  number: number;
  url: string;
}

export interface PullState {
  state: "open" | "closed";
  merged: boolean;
  /** The commit the merge put on the base branch (merged PRs). */
  mergeCommit?: string;
  headSha: string;
  /** Who opened it: the token's owner. */
  author: string;
  /** False when the PR conflicts with its base; null while GitHub is still computing it. */
  mergeable: boolean | null;
}

export interface Review {
  id: number;
  state: string;
  body: string;
  author: string;
  /** The PR head the review was written against. */
  commit: string;
}

export interface ReviewComment {
  path: string;
  line?: number;
  body: string;
}

/** A check run (GitHub Actions and other apps) on a commit. */
export interface CheckRun {
  name: string;
  /** queued, in_progress, completed... */
  status: string;
  /** success, failure, neutral, skipped, cancelled, timed_out... once completed. */
  conclusion: string | null;
  url?: string;
}

/** A commit status (the older API some CI services use). */
export interface CommitStatus {
  context: string;
  /** success, pending, failure or error. */
  state: string;
  url?: string;
}

interface PullJson {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  mergeable?: boolean | null;
  head: { sha: string };
  user?: { login: string } | null;
}

export class GitHubApi {
  private readonly base: string;

  constructor(
    readonly slug: RepoSlug,
    private readonly token: string,
    apiUrl = GITHUB_API,
  ) {
    this.base = `${apiUrl.replace(/\/+$/, "")}/repos/${slug.owner}/${slug.repo}`;
  }

  /** The open PR from `branch`, if there is one. */
  async findOpenPull(branch: string): Promise<PullRef | undefined> {
    const pulls = await this.call<PullJson[]>("GET", `/pulls?state=open&head=${encodeURIComponent(`${this.slug.owner}:${branch}`)}`);
    return pulls[0] && { number: pulls[0].number, url: pulls[0].html_url };
  }

  async createPull(pull: { title: string; head: string; base: string; body: string }): Promise<PullRef> {
    const created = await this.call<PullJson>("POST", "/pulls", pull);
    return { number: created.number, url: created.html_url };
  }

  async updatePull(number: number, change: { body?: string; state?: "open" | "closed" }): Promise<void> {
    await this.call("PATCH", `/pulls/${number}`, change);
  }

  async getPull(number: number): Promise<PullState> {
    const p = await this.call<PullJson>("GET", `/pulls/${number}`);
    const merged = p.merged === true || !!p.merged_at;
    return {
      state: p.state,
      merged,
      mergeCommit: merged ? (p.merge_commit_sha ?? undefined) : undefined,
      headSha: p.head.sha,
      author: p.user?.login ?? "",
      mergeable: p.mergeable ?? null,
    };
  }

  async reviews(number: number): Promise<Review[]> {
    const list = await this.call<Array<{ id: number; state: string; body: string | null; user: { login: string } | null; commit_id: string }>>(
      "GET",
      `/pulls/${number}/reviews?per_page=100`,
    );
    return list.map((r) => ({ id: r.id, state: r.state, body: r.body ?? "", author: r.user?.login ?? "someone", commit: r.commit_id }));
  }

  /**
   * A review's comments on the code. Read from the pull request's comment list: the per-review
   * endpoint leaves out line numbers.
   */
  async reviewComments(number: number, reviewId: number): Promise<ReviewComment[]> {
    const list = await this.call<
      Array<{ pull_request_review_id: number | null; path: string; line?: number | null; original_line?: number | null; body: string }>
    >("GET", `/pulls/${number}/comments?per_page=100`);
    return list
      .filter((c) => c.pull_request_review_id === reviewId)
      .map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? undefined, body: c.body }));
  }

  /** Merge the pull request if its head is still `sha`; returns the merge commit on the base branch. */
  async mergePull(number: number, sha: string): Promise<string> {
    const merged = await this.call<{ sha: string; merged: boolean }>("PUT", `/pulls/${number}/merge`, { sha, merge_method: "merge" });
    return merged.sha;
  }

  async checkRuns(sha: string): Promise<CheckRun[]> {
    const page = await this.call<{ check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url?: string | null }> }>(
      "GET",
      `/commits/${sha}/check-runs?per_page=100`,
    );
    return page.check_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url ?? undefined }));
  }

  async statuses(sha: string): Promise<CommitStatus[]> {
    const combined = await this.call<{ statuses: Array<{ context: string; state: string; target_url?: string | null }> }>("GET", `/commits/${sha}/status`);
    return combined.statuses.map((s) => ({ context: s.context, state: s.state, url: s.target_url ?? undefined }));
  }

  async comment(number: number, body: string): Promise<void> {
    await this.call("POST", `/issues/${number}/comments`, { body });
  }

  private async call<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${route}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new GitHubError(`GitHub unreachable: ${(err as Error).message}`, 0);
    }
    if (!res.ok) {
      const detail = ((await res.json().catch(() => ({}))) as { message?: string; errors?: Array<{ message?: string }> }) ?? {};
      const extra = detail.errors?.map((e) => e.message).filter(Boolean).join("; ");
      throw new GitHubError(`GitHub ${method} ${route.split("?")[0]}: HTTP ${res.status} ${detail.message ?? ""}${extra ? ` (${extra})` : ""}`.trim(), res.status);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
}
