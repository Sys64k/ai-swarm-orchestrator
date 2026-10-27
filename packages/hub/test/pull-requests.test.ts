import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { autoMergeBlock, changesRequested, lastBuild, checkState, GitHubError, mergeBlock, parseDiff, parseGitHubRemote, parseGitHubRepo, pullRequestBody, reviewFeedback, startHub, summarizeChecks, type TaskRecord } from "@aso/hub";
import { createMessage } from "@aso/shared";
import { git, gitAsync, makeTargetRepo, postTask, pushTaskBranch, tempDir, TOKEN, waitFor, withHub, worker, writeFiles, type HubContext, type TestClient } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const GH_TOKEN = "github-token";
const SLUG = { owner: "me", repo: "shop" };

interface FakePull {
  number: number;
  head: string;
  base: string;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergeCommit?: string;
  mergeable: boolean | null;
  comments: string[];
  reviews: Array<{ id: number; state: string; body: string; user: { login: string }; commit_id: string }>;
  reviewComments: Map<number, Array<{ path: string; line: number; body: string }>>;
}

/** GitHub's pull request API, in memory, over the bare repository the Hub pushes to. */
class FakeGitHub {
  readonly pulls = new Map<number, FakePull>();
  /** Requests that did not carry the token. */
  unauthorized = 0;
  /** The next N `POST /pulls` fail with HTTP 502. */
  failCreates = 0;
  /** Check runs and commit statuses per commit. */
  checkRuns = new Map<string, Array<{ name: string; status: string; conclusion: string | null; html_url: string }>>();
  statuses = new Map<string, Array<{ context: string; state: string; target_url: string }>>();
  /** What `GET /repos/me/shop` says about the repository and the token's access to it. */
  repoInfo = { default_branch: "main", permissions: { push: true } };
  /** The token may read no checks at all (no Actions or Commit statuses access). */
  checksForbidden = false;
  /** Check runs are refused but Actions are not: a fine-grained token, which can't have Checks. */
  checkRunsForbidden = false;
  originDir = "";
  private server?: Server;
  url = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ([status, body]) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        },
        (err: Error) => {
          res.statusCode = 500;
          res.end(JSON.stringify({ message: err.message }));
        },
      );
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.server?.close();
  }

  reset(originDir: string): void {
    this.pulls.clear();
    this.unauthorized = 0;
    this.failCreates = 0;
    this.checkRuns.clear();
    this.statuses.clear();
    this.checksForbidden = false;
    this.checkRunsForbidden = false;
    this.repoInfo = { default_branch: "main", permissions: { push: true } };
    this.originDir = originDir;
  }

  private headSha(branch: string): string {
    return git(this.originDir, "rev-parse", `refs/heads/${branch}`);
  }

  private json(pull: FakePull) {
    return {
      number: pull.number,
      html_url: `https://github.com/${SLUG.owner}/${SLUG.repo}/pull/${pull.number}`,
      state: pull.state,
      merged: pull.merged,
      merge_commit_sha: pull.mergeCommit ?? null,
      mergeable: pull.mergeable,
      head: { sha: pull.merged ? (pull.mergeCommit ?? "") : this.headSha(pull.head) },
      user: { login: "hub-token-owner" },
    };
  }

  private async handle(req: IncomingMessage): Promise<[number, unknown]> {
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}`) {
      this.unauthorized++;
      return [401, { message: "Bad credentials" }];
    }
    const url = new URL(req.url!, "http://x");
    const prefix = `/repos/${SLUG.owner}/${SLUG.repo}`;
    if (!url.pathname.startsWith(prefix)) return [404, { message: "Not Found" }];
    const route = url.pathname.slice(prefix.length);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};

    if (req.method === "GET" && route === "") return [200, this.repoInfo];
    if (req.method === "GET" && route === "/pulls") {
      const head = url.searchParams.get("head")?.split(":")[1];
      return [200, [...this.pulls.values()].filter((p) => p.state === "open" && p.head === head).map((p) => this.json(p))];
    }
    if (req.method === "POST" && route === "/pulls") {
      if (this.failCreates > 0) {
        this.failCreates--;
        return [502, { message: "Server Error" }];
      }
      const number = this.pulls.size + 1;
      const pull: FakePull = {
        number,
        head: String(body.head),
        base: String(body.base),
        title: String(body.title),
        body: String(body.body),
        state: "open",
        merged: false,
        mergeable: true,
        comments: [],
        reviews: [],
        reviewComments: new Map(),
      };
      this.pulls.set(number, pull);
      return [201, this.json(pull)];
    }
    const commit = /^\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(route);
    const forbidden: [number, unknown] = [403, { message: "Resource not accessible by personal access token" }];
    // Actions: one workflow run per commit with check runs, numbered by its place in the map.
    if (route === "/actions/runs" && req.method === "GET") {
      if (this.checksForbidden) return forbidden;
      const shas = [...this.checkRuns.keys()];
      const id = shas.indexOf(url.searchParams.get("head_sha") ?? "");
      return [200, { workflow_runs: id === -1 ? [] : [{ id: id + 1 }] }];
    }
    const jobs = /^\/actions\/runs\/(\d+)\/jobs$/.exec(route);
    if (jobs && req.method === "GET") {
      if (this.checksForbidden) return forbidden;
      return [200, { jobs: [...this.checkRuns.values()][Number(jobs[1]) - 1] ?? [] }];
    }
    if (commit && req.method === "GET") {
      if (this.checksForbidden || (this.checkRunsForbidden && commit[2] === "check-runs")) return forbidden;
      return commit[2] === "check-runs"
        ? [200, { total_count: 0, check_runs: this.checkRuns.get(commit[1]) ?? [] }]
        : [200, { state: "pending", statuses: this.statuses.get(commit[1]) ?? [] }];
    }
    const m = /^\/(pulls|issues)\/(\d+)(\/.*)?$/.exec(route);
    const pull = m && this.pulls.get(Number(m[2]));
    if (!m || !pull) return [404, { message: "Not Found" }];
    const rest = m[3] ?? "";
    if (m[1] === "issues" && rest === "/comments" && req.method === "POST") {
      pull.comments.push(String(body.body));
      return [201, {}];
    }
    if (rest === "" && req.method === "GET") return [200, this.json(pull)];
    if (rest === "" && req.method === "PATCH") {
      if (typeof body.body === "string") pull.body = body.body;
      if (body.state === "closed") pull.state = "closed";
      return [200, this.json(pull)];
    }
    if (rest === "/merge" && req.method === "PUT") {
      if (pull.state !== "open") return [405, { message: "Pull Request is not mergeable" }];
      if (body.sha !== this.headSha(pull.head)) return [409, { message: "Head branch was modified. Review and try the merge again." }];
      return [200, { sha: this.merge(pull.number), merged: true }];
    }
    if (rest === "/reviews" && req.method === "GET") return [200, pull.reviews];
    if (rest === "/comments" && req.method === "GET") {
      // Like GitHub: \`line\` is often null; \`original_line\` has it.
      return [200, [...pull.reviewComments].flatMap(([id, list]) => list.map((c) => ({ pull_request_review_id: id, path: c.path, line: null, original_line: c.line, body: c.body })))];
    }
    return [404, { message: "Not Found" }];
  }

  /** A person reviews the PR's current commit. */
  review(
    number: number,
    state: "CHANGES_REQUESTED" | "APPROVED" | "COMMENTED",
    text: string,
    comments: Array<{ path: string; line: number; body: string }> = [],
    login = "reviewer",
  ): number {
    const pull = this.pulls.get(number)!;
    const id = 100 + pull.reviews.length + number * 1000;
    pull.reviews.push({ id, state, body: text, user: { login }, commit_id: this.headSha(pull.head) });
    pull.reviewComments.set(id, comments);
    return id;
  }

  /** A person presses Merge: the branch is merged into main on "GitHub". */
  merge(number: number): string {
    const pull = this.pulls.get(number)!;
    const dir = tempDir("aso-github-merge-");
    try {
      git(dir, "clone", "--quiet", this.originDir, ".");
      git(dir, "-c", "user.name=GitHub", "-c", "user.email=gh@example.com", "merge", "--no-ff", "--quiet", "-m", `Merge pull request #${number}`, `origin/${pull.head}`);
      git(dir, "push", "--quiet", "origin", "main");
      pull.mergeCommit = git(dir, "rev-parse", "HEAD");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    pull.merged = true;
    pull.state = "closed";
    return pull.mergeCommit;
  }
}

const github = new FakeGitHub();
before(() => github.start());
after(() => github.stop());

const task = (taskId: string, extra: Record<string, unknown> = {}) => ({ taskId, role: "backend", title: `Task ${taskId}`, description: `Build ${taskId}.`, ...extra });

/** A Hub whose project remote is "GitHub": a bare repository plus the fake API. */
function withGitHub(fn: (ctx: HubContext) => Promise<void>, opts: Record<string, unknown> = {}) {
  return withHub(
    async (ctx) => {
      github.reset(ctx.originDir!);
      await fn(ctx);
      assert.equal(github.unauthorized, 0, "every GitHub call carried the token");
    },
    { origin: true, sync: { token: GH_TOKEN }, pullRequests: { apiUrl: github.url, repo: SLUG, pollMs: 60_000 }, reclaimGraceMs: 10_000, ...opts },
  );
}

/** `dev` implements `taskId` with `files`, and `qa` passes it. */
async function implementAndPass(ctx: HubContext, dev: TestClient, qa: TestClient, taskId: string, files: Record<string, string>, summary?: string): Promise<string> {
  const assignment = await dev.next();
  assert.ok(assignment.type === "TASK_ASSIGNMENT" && assignment.payload.taskId === taskId, `assigned ${taskId}`);
  dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId, slot: 1 }));
  const commit = await pushTaskBranch(ctx.gitUrl, taskId, files);
  dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId, commit, ...(summary ? { detail: summary } : {}) }));
  const run = await qa.next();
  assert.ok(run.type === "TEST_EXECUTION" && run.payload.commit === commit);
  qa.send(createMessage("STATUS_UPDATE", "qa", { state: "in_progress", taskId }));
  qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId, commit, outcome: "pass", summary: "12 tests passed" }));
  return commit;
}

/** The agent's next commit on an existing task branch (a rework resumes the branch). */
async function continueTaskBranch(ctx: HubContext, taskId: string, files: Record<string, string>): Promise<string> {
  const dir = tempDir("aso-rework-");
  try {
    await gitAsync(dir, "clone", "--quiet", ctx.gitUrl, ".");
    git(dir, "checkout", "--quiet", `task/${taskId}`);
    writeFiles(dir, files);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", `rework ${taskId}`);
    await gitAsync(dir, "push", "--quiet", "origin", `task/${taskId}`);
    return git(dir, "rev-parse", "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A CI check on the pull request's current commit. */
function addCheck(taskId: string, name: string, conclusion: string | null) {
  const sha = git(github.originDir, "rev-parse", `refs/heads/task/${taskId}`);
  const runs = github.checkRuns.get(sha) ?? [];
  runs.push({ name, status: conclusion ? "completed" : "in_progress", conclusion, html_url: `https://github.com/me/shop/runs/${runs.length + 1}` });
  github.checkRuns.set(sha, runs);
}

async function api(port: number, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

const reviewed = (ctx: HubContext, taskId: string) =>
  waitFor(() => {
    const t = ctx.hub.tasks.get(taskId);
    return t?.state === "awaiting_review" && t.review?.pr && t;
  }, 10_000, `${taskId} awaiting review with a PR`);

/** As if the acceptance check had passed the task's last build (these tests run without one). */
const passedAcceptance = (ctx: HubContext, taskId: string) => {
  lastBuild(ctx.hub.tasks.get(taskId)!.jobs)!.acceptance = "met";
};
/** What overturned the acceptance check's verdict on the task's build that went to review, if anything. */
const overturnedOf = (ctx: HubContext, taskId: string) => ctx.hub.tasks.get(taskId)!.jobs!.find((j) => j.acceptance === "met")?.overturned;

describe("pull requests on GitHub", () => {
  it("opens a pull request after QA instead of merging, and merges into the Hub's main once merged on GitHub", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { slots: 2 });
      const qa = await worker(ctx.port, "qa");
      const mainBefore = git(ctx.repoDir, "rev-parse", "main");
      await postTask(ctx.port, task("greet", { acceptanceCriteria: ["says hello"] }));
      await postTask(ctx.port, task("follow", { dependsOn: ["greet"] }));
      // Longer than the 2,000 characters a status update once held, ending in a marker.
      const summary = `Added greeting.txt. ${"Checked it. ".repeat(250)}The end.`;
      const commit = await implementAndPass(ctx, dev, qa, "greet", { "greeting.txt": "hello\n" }, summary);

      const t = await reviewed(ctx, "greet");
      assert.equal(t.summary, summary, "the whole summary reached the Hub");
      assert.equal(git(ctx.originDir!, "rev-parse", "refs/heads/task/greet"), commit, "the branch is on GitHub");
      assert.equal(git(ctx.repoDir, "rev-parse", "main"), mainBefore, "nothing merged on the Hub");
      const pull = github.pulls.get(t.review!.pr!.number)!;
      assert.deepEqual([pull.title, pull.head, pull.base], ["Task greet", "task/greet", "main"]);
      assert.match(pull.body, /Build greet\./);
      assert.match(pull.body, /- says hello/);
      assert.ok(pull.body.includes(`**What the agent did**\n\n${summary}\n`), "the agent's whole summary is in the pull request");
      assert.match(pull.body, /\*\*QA:\*\* 12 tests passed/);
      assert.match(pull.body, /requests changes\*\* \(on a pull request you opened yourself, GitHub only offers \*\*Comment\*\*/);
      assert.equal(t.review!.pr!.url, `https://github.com/me/shop/pull/${pull.number}`);
      assert.match(ctx.hub.tasks.get("follow")!.waitingReason ?? "", /waiting for greet to be merged/);

      const project = (await (await fetch(`http://127.0.0.1:${ctx.port}/api/projects`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Array<Record<string, any>>;
      assert.deepEqual(project[0].pullRequests, { enabled: true, repo: "me/shop" });
      assert.equal(project[0].tasks.reviewing, 1);

      const mergeCommit = github.merge(pull.number);
      await ctx.hub.projects.checkReviews("project");
      const merged = ctx.hub.tasks.get("greet")!;
      assert.equal(merged.state, "merged");
      assert.equal(merged.mainCommit, mergeCommit);
      assert.equal(git(ctx.repoDir, "rev-parse", "main"), mergeCommit, "the Hub's main caught up with GitHub's");
      assert.equal(git(ctx.repoDir, "show", "main:greeting.txt"), "hello");
      assert.equal(git(ctx.repoDir, "status", "--porcelain"), "");
      const next = await dev.next();
      assert.ok(next.type === "TASK_ASSIGNMENT" && next.payload.taskId === "follow", "the dependant starts after the merge");
      dev.ws.close();
      qa.ws.close();
    }));

  it("sends requested changes back to an agent with the review, then updates the same pull request", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("greet"));
      await implementAndPass(ctx, dev, qa, "greet", { "greeting.txt": "hello\n" });
      const number = (await reviewed(ctx, "greet")).review!.pr!.number;
      passedAcceptance(ctx, "greet");

      github.review(number, "COMMENTED", "just a thought");
      await ctx.hub.projects.checkReviews("project");
      assert.equal(ctx.hub.tasks.get("greet")!.state, "awaiting_review", "a comment is not a decision");
      assert.equal(overturnedOf(ctx, "greet"), undefined);

      github.review(number, "CHANGES_REQUESTED", "Say hello politely.", [{ path: "greeting.txt", line: 1, body: "Use 'Hello there'" }]);
      await ctx.hub.projects.checkReviews("project");
      const back = await dev.next();
      assert.ok(back.type === "TASK_ASSIGNMENT" && back.payload.rework);
      assert.equal(back.payload.rework.round, 1);
      assert.match(back.payload.rework.reason, /^Review round 1: reviewer asked for changes on GitHub: Say hello politely\.$/);
      assert.match(back.payload.rework.output ?? "", /- greeting\.txt:1: Use 'Hello there'/);
      const t = ctx.hub.tasks.get("greet")!;
      assert.deepEqual([t.reworkRound, t.review!.rounds], [0, 1], "review rounds do not count towards the rework limit");
      assert.equal(overturnedOf(ctx, "greet"), "changesRequested", "the acceptance check had passed what the person sent back");

      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet" }));
      const fixed = await continueTaskBranch(ctx, "greet", { "greeting.txt": "Hello there\n" });
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: fixed }));
      const run = await qa.next();
      assert.ok(run.type === "TEST_EXECUTION");
      qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId: "greet", commit: fixed, outcome: "pass", summary: "13 tests passed" }));
      await waitFor(() => ctx.hub.tasks.get("greet")!.history.some((h) => h.event.includes(`pull request #${number} updated`)), 10_000, "PR updated");
      assert.equal(github.pulls.size, 1, "the same pull request");
      assert.equal(git(ctx.originDir!, "rev-parse", "refs/heads/task/greet"), fixed);
      const pull = github.pulls.get(number)!;
      assert.match(pull.comments.at(-1)!, /passed QA: 13 tests passed\. Ready for review again\./);
      assert.match(pull.body, /after 1 review round/);

      await ctx.hub.projects.checkReviews("project");
      assert.equal(ctx.hub.tasks.get("greet")!.state, "awaiting_review", "the old review was about the old commit");

      // The token's owner reviews their own pull request: GitHub only lets them Comment.
      github.review(number, "COMMENTED", "Add a full stop.", [], "hub-token-owner");
      await ctx.hub.projects.checkReviews("project");
      const own = await dev.next();
      assert.ok(own.type === "TASK_ASSIGNMENT" && own.payload.rework);
      assert.match(own.payload.rework.reason, /^Review round 2: hub-token-owner asked for changes on GitHub: Add a full stop\.$/);
      dev.ws.close();
      qa.ws.close();
    }));

  it("cancels the task when the pull request is closed, and closes it when the task is cancelled here", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("one"));
      await implementAndPass(ctx, dev, qa, "one", { "one.txt": "1\n" });
      const first = (await reviewed(ctx, "one")).review!.pr!.number;
      passedAcceptance(ctx, "one");
      github.pulls.get(first)!.state = "closed";
      await ctx.hub.projects.checkReviews("project");
      assert.equal(ctx.hub.tasks.get("one")!.state, "cancelled");
      assert.equal(overturnedOf(ctx, "one"), "closed", "a person closed what the acceptance check passed");

      await postTask(ctx.port, task("two"));
      await implementAndPass(ctx, dev, qa, "two", { "two.txt": "2\n" });
      const second = (await reviewed(ctx, "two")).review!.pr!.number;
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/tasks/two/cancel`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 200);
      await waitFor(() => github.pulls.get(second)!.state === "closed", 5000, "PR closed");
      assert.equal(ctx.hub.tasks.get("two")!.jobs!.at(-1)!.overturned, undefined, "cancelled here: not a verdict on the work");
      assert.match(github.pulls.get(second)!.comments.at(-1)!, /cancelled from the ASO console/);
      dev.ws.close();
      qa.ws.close();
    }));

  /** Take `id` to review, send it back, and have the rework's agent give up: failed, with its pull request open. */
  async function failWithOpenPr(ctx: HubContext, dev: TestClient, qa: TestClient, id: string): Promise<number> {
    await postTask(ctx.port, task(id));
    await implementAndPass(ctx, dev, qa, id, { [`${id}.txt`]: "1\n" });
    const pr = (await reviewed(ctx, id)).review!.pr!.number;
    const changes = await fetch(`http://127.0.0.1:${ctx.port}/api/tasks/${id}/request-changes`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "please redo" }),
    });
    assert.equal(changes.status, 200);
    // The rework goes to whichever machine is free.
    await waitFor(() => ctx.hub.tasks.get(id)?.state === "assigned");
    const nodeId = ctx.hub.tasks.get(id)!.nodeId!;
    const owner = nodeId === "dev" ? dev : qa;
    assert.equal((await owner.next()).type, "TASK_ASSIGNMENT");
    owner.send(createMessage("STATUS_UPDATE", nodeId, { state: "failed", taskId: id, detail: "gave up" }));
    await waitFor(() => ctx.hub.tasks.get(id)?.state === "failed");
    assert.equal(github.pulls.get(pr)!.state, "open", "still open after the failure");
    return pr;
  }

  it("closes a failed task's pull request when a newer task supersedes it", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      const pr = await failWithOpenPr(ctx, dev, qa, "one");
      ctx.hub.projects.list()[0].tasks.supersede("one", "three");
      await waitFor(() => github.pulls.get(pr)!.state === "closed", 5000, "PR closed when superseded");
      assert.match(github.pulls.get(pr)!.comments.at(-1)!, /Superseded by three, which does this task's job/);
      dev.ws.close();
      qa.ws.close();
    }));

  it("closes a failed task's pull request when it's retried, since the retry opens its own", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      const pr = await failWithOpenPr(ctx, dev, qa, "one");
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/tasks/one/retry`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 200);
      await waitFor(() => github.pulls.get(pr)!.state === "closed", 5000, "PR closed on retry");
      assert.match(github.pulls.get(pr)!.comments.at(-1)!, /being retried; its next attempt opens a new pull request/);
      dev.ws.close();
      qa.ws.close();
    }));

  it("says why an auto-merge task still needs a person", () => {
    const met = { result: "met" as const, commit: "c1", at: "t", criteria: [{ criterion: "a", verdict: "met" as const, reason: "r" }] };
    const checks = (over: Record<string, unknown> = {}) => ({ pr: { number: 1, url: "u" }, headSha: "c1", mergeable: true, overall: "passing", checks: [], ...over }) as never;
    const task = { autoMerge: true, commit: "c1", acceptance: met };
    assert.equal(autoMergeBlock(task, checks()), undefined);
    assert.equal(autoMergeBlock({ ...task, autoMerge: undefined }, checks()), "it isn't an auto-merge task");
    assert.equal(autoMergeBlock({ ...task, acceptance: undefined }, checks()), "not every acceptance criterion is met", "no acceptance check: a person decides");
    assert.equal(autoMergeBlock({ ...task, acceptance: { ...met, criteria: [] } }, checks()), "not every acceptance criterion is met");
    assert.equal(autoMergeBlock(task, checks({ headSha: "c2" })), "its pull request has a commit QA didn't test");
    assert.equal(autoMergeBlock(task, checks({ mergeable: false })), "it conflicts with main");
    assert.equal(autoMergeBlock(task, checks({ overall: "none" })), "its CI checks are none", "no CI: a person decides");
    assert.equal(autoMergeBlock(task, checks({ overall: "failing" })), "its CI checks are failing");
  });

  it("merges an auto-merge task (an API sync) without a person only once every criterion is met and CI passes", async () => {
    let verdict: "met" | "unclear" = "unclear";
    const acceptance = {
      check: async (t: { spec: { acceptanceCriteria: string[] } }) => ({
        result: "met" as const,
        criteria: t.spec.acceptanceCriteria.map((criterion) => ({ criterion, verdict, reason: "r" })),
        summary: "",
        model: "claude-opus-5-5",
      }),
    };
    await withGitHub(
      async (ctx) => {
        const dev = await worker(ctx.port, "dev");
        const qa = await worker(ctx.port, "qa");
        const run = async (id: string) => {
          await postTask(ctx.port, { ...task(id), acceptanceCriteria: ["the copy is synced", "tests pass"] });
          ctx.hub.tasks.get(id)!.autoMerge = true; // as the Hub marks its API syncs
          await implementAndPass(ctx, dev, qa, id, { [`${id}.txt`]: "1\n" });
          return reviewed(ctx, id);
        };

        // One criterion unclear: it waits for a person, even with CI passing.
        await run("unclear");
        addCheck("unclear", "test", "success");
        await ctx.hub.projects.checkReviews("project");
        assert.equal(ctx.hub.tasks.get("unclear")!.state, "awaiting_review");

        verdict = "met";
        await run("synced");
        addCheck("synced", "test", null); // CI still running: it waits
        await ctx.hub.projects.checkReviews("project");
        assert.equal(ctx.hub.tasks.get("synced")!.state, "awaiting_review");
        addCheck("synced", "lint", "success");
        github.checkRuns.set(git(github.originDir, "rev-parse", "refs/heads/task/synced"), [{ name: "test", status: "completed", conclusion: "success", html_url: "x" }]);
        await ctx.hub.projects.checkReviews("project");
        await waitFor(() => ctx.hub.tasks.get("synced")?.state === "merged", 5000, "merged without a person").catch((e) => {
          throw new Error(`${e.message}: ${JSON.stringify(ctx.hub.tasks.get("synced")!.history.slice(-4).map((h) => h.event))} acceptance=${JSON.stringify(ctx.hub.tasks.get("synced")!.acceptance?.criteria?.map((c) => c.verdict))}`);
        });
        assert.ok(ctx.hub.tasks.get("synced")!.history.some((h) => /merging without a person: an API sync with every acceptance criterion met and CI passing/.test(h.event)));
        dev.ws.close();
        qa.ws.close();
      },
      { acceptanceCheck: acceptance },
    );
  });

  it("reworks a pull request that conflicts with main, after bringing in GitHub's main", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("clash"));
      await implementAndPass(ctx, dev, qa, "clash", { "x.txt": "mine\n" });
      const number = (await reviewed(ctx, "clash")).review!.pr!.number;

      const elsewhere = tempDir("aso-elsewhere-");
      git(elsewhere, "clone", "--quiet", ctx.originDir!, ".");
      writeFiles(elsewhere, { "x.txt": "theirs\n" });
      git(elsewhere, "add", "-A");
      git(elsewhere, "commit", "--quiet", "-m", "theirs");
      git(elsewhere, "push", "--quiet", "origin", "main");
      const theirs = git(elsewhere, "rev-parse", "HEAD");
      github.pulls.get(number)!.mergeable = false;

      await ctx.hub.projects.checkReviews("project");
      const back = await dev.next();
      assert.ok(back.type === "TASK_ASSIGNMENT" && back.payload.rework);
      assert.match(back.payload.rework.reason, /conflicts with main; rebase onto main and resolve/);
      assert.equal(ctx.hub.tasks.get("clash")!.reworkRound, 1, "a conflict counts as a rework round");
      assert.equal(git(ctx.repoDir, "rev-parse", "main"), theirs, "the agent rebases onto GitHub's main");
      dev.ws.close();
      qa.ws.close();
    }));

  it("keeps trying when GitHub is unreachable or failing", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      github.failCreates = 1;
      await postTask(ctx.port, task("flaky"));
      await implementAndPass(ctx, dev, qa, "flaky", { "f.txt": "f\n" });
      const failed = await waitFor(() => ctx.hub.tasks.get("flaky")?.review?.error, 10_000, "open failed");
      assert.match(failed, /HTTP 502/);
      assert.equal(ctx.hub.tasks.get("flaky")!.state, "awaiting_review");

      await ctx.hub.projects.checkReviews("project");
      const t = ctx.hub.tasks.get("flaky")!;
      assert.ok(t.review!.pr, "opened on the next check");
      assert.equal(t.review!.error, undefined);
      dev.ws.close();
      qa.ws.close();
    }));

  it("keeps waiting for the review across a Hub restart", async () => {
    const repoDir = makeTargetRepo();
    const originDir = tempDir("aso-origin-");
    git(originDir, "init", "--quiet", "--bare", "--initial-branch=main");
    git(repoDir, "remote", "add", "origin", originDir);
    git(repoDir, "push", "--quiet", "origin", "main");
    github.reset(originDir);
    const options = {
      targetDir: repoDir,
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      sync: { token: GH_TOKEN },
      pullRequests: { apiUrl: github.url, repo: SLUG, pollMs: 60_000 },
    };
    let hub = await startHub(options);
    try {
      const ctx = { hub, port: hub.port, repoDir, originDir, gitUrl: `http://127.0.0.1:${hub.port}/git/project.git` } as HubContext;
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("greet"));
      await implementAndPass(ctx, dev, qa, "greet", { "greeting.txt": "hello\n" });
      const number = (await reviewed(ctx, "greet")).review!.pr!.number;
      dev.ws.close();
      qa.ws.close();

      await hub.close();
      hub = await startHub(options);
      const t = hub.tasks.get("greet")!;
      assert.deepEqual([t.state, t.review?.pr?.number], ["awaiting_review", number]);
      const mergeCommit = github.merge(number);
      await hub.projects.checkReviews("project");
      assert.equal(hub.tasks.get("greet")!.state, "merged");
      assert.equal(git(repoDir, "rev-parse", "main"), mergeCommit);
      assert.equal(github.pulls.size, 1, "no second pull request after the restart");
      await hub.sync.requestPush(); // let the push after the merge finish before the repository goes
    } finally {
      await hub.close();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("merges on the Hub as before when pull requests are off", () =>
    withGitHub(
      async (ctx) => {
        const dev = await worker(ctx.port, "dev");
        const qa = await worker(ctx.port, "qa");
        await postTask(ctx.port, task("plain"));
        await implementAndPass(ctx, dev, qa, "plain", { "p.txt": "p\n" });
        await waitFor(() => ctx.hub.tasks.get("plain")?.state === "merged", 10_000, "merged");
        assert.equal(github.pulls.size, 0);
        const project = (await (await fetch(`http://127.0.0.1:${ctx.port}/api/projects`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Array<Record<string, any>>;
        assert.match(project[0].pullRequests.reason, /ASO_PULL_REQUESTS=0/);
        dev.ws.close();
        qa.ws.close();
      },
      { pullRequests: { enabled: false } },
    ));

  it("says why pull requests are off without a GitHub remote or token", async () => {
    for (const [opts, reason] of [
      [{ origin: true, sync: { token: GH_TOKEN } }, /origin is not a GitHub repository/],
      [{ origin: true, pullRequests: { repo: SLUG } }, /no GitHub token/],
      [{}, /no "origin" remote/],
    ] as const) {
      await withHub(async (ctx) => {
        const project = (await (await fetch(`http://127.0.0.1:${ctx.port}/api/projects`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Array<Record<string, any>>;
        assert.equal(project[0].pullRequests.enabled, false);
        assert.match(project[0].pullRequests.reason, reason);
      }, opts);
    }
  });
});

describe("reviewing in ASO", () => {
  it("shows what the task changes and its checks, then merges the pull request once approved", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { slots: 2 });
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("greet"));
      await postTask(ctx.port, task("follow", { dependsOn: ["greet"] }));
      const commit = await implementAndPass(ctx, dev, qa, "greet", { "greeting.txt": "hello\n", "README.md": "# Target\nNow it greets.\n" });
      const number = (await reviewed(ctx, "greet")).review!.pr!.number;

      const diff = await api(ctx.port, "GET", "tasks/greet/diff");
      assert.equal(diff.status, 200);
      assert.equal(diff.data.head, commit);
      assert.deepEqual(
        diff.data.files.map((f: any) => [f.path, f.status, f.additions]),
        [["README.md", "modified", 2], ["greeting.txt", "added", 1]],
      );
      assert.match(diff.data.files[1].patch, /^diff --git a\/greeting\.txt b\/greeting\.txt\nnew file mode[\s\S]*\n\+hello$/);
      assert.equal(diff.data.truncated, false);

      addCheck("greet", "unit", "success");
      addCheck("greet", "lint", "skipped");
      const checks = await api(ctx.port, "GET", "tasks/greet/checks");
      assert.equal(checks.status, 200);
      assert.equal(checks.data.overall, "passing");
      assert.equal(checks.data.headSha, commit);
      assert.deepEqual(checks.data.checks.map((c: any) => [c.name, c.state]), [["unit", "passing"], ["lint", "skipped"]]);

      const approved = await api(ctx.port, "POST", "tasks/greet/approve");
      assert.equal(approved.status, 200, approved.data.error);
      assert.equal(approved.data.state, "merged");
      const pull = github.pulls.get(number)!;
      assert.ok(pull.merged, "merged on GitHub");
      assert.equal(approved.data.mainCommit, pull.mergeCommit);
      assert.equal(git(ctx.repoDir, "rev-parse", "main"), pull.mergeCommit, "the Hub's main caught up");
      assert.match(approved.data.history.at(-1).event, new RegExp(`pull request #${number} merged from ASO @`));
      const next = await dev.next();
      assert.ok(next.type === "TASK_ASSIGNMENT" && next.payload.taskId === "follow", "the dependant starts");

      assert.equal((await api(ctx.port, "GET", "tasks/greet/diff")).status, 409, "a merged task has no diff of its own");
      assert.equal((await api(ctx.port, "POST", "tasks/greet/approve")).status, 409, "approved once");
      await ctx.hub.sync.requestPush(); // let the push after the merge finish before the repository goes
      dev.ws.close();
      qa.ws.close();
    }));

  it("refuses to merge while checks fail, run or can't be read, unless forced", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("red"));
      await implementAndPass(ctx, dev, qa, "red", { "r.txt": "r\n" });
      const number = (await reviewed(ctx, "red")).review!.pr!.number;

      github.checksForbidden = true;
      const unreadable = await api(ctx.port, "GET", "tasks/red/checks");
      assert.equal(unreadable.data.overall, "unknown");
      assert.match(unreadable.data.error, /read access to Actions and Commit statuses/);
      const refusedUnknown = await api(ctx.port, "POST", "tasks/red/approve", {});
      assert.equal(refusedUnknown.status, 409);
      assert.match(refusedUnknown.data.error, /checks can't be read .*; approve with force to merge anyway/);

      github.checksForbidden = false;
      github.checkRunsForbidden = true; // a fine-grained token: the same results, read through Actions
      addCheck("red", "unit", "success");
      addCheck("red", "Playwright e2e", null);
      assert.match((await api(ctx.port, "POST", "tasks/red/approve")).data.error, /^checks pending: Playwright e2e; approve with force/);

      addCheck("red", "Docker build", "failure");
      const refused = await api(ctx.port, "POST", "tasks/red/approve", { force: false });
      assert.equal(refused.status, 409);
      assert.match(refused.data.error, /^checks failing: Docker build; approve with force/);
      assert.equal(github.pulls.get(number)!.merged, false);
      assert.equal(ctx.hub.tasks.get("red")!.state, "awaiting_review");

      assert.equal((await api(ctx.port, "POST", "tasks/red/approve", { force: "yes" })).status, 400);
      const forced = await api(ctx.port, "POST", "tasks/red/approve", { force: true });
      assert.equal(forced.status, 200, forced.data.error);
      assert.equal(forced.data.state, "merged");
      assert.ok(github.pulls.get(number)!.merged);
      await ctx.hub.sync.requestPush();
      dev.ws.close();
      qa.ws.close();
    }));

  it("won't merge a pull request that conflicts or carries a commit QA did not test", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("odd"));
      await implementAndPass(ctx, dev, qa, "odd", { "o.txt": "o\n" });
      const number = (await reviewed(ctx, "odd")).review!.pr!.number;

      github.pulls.get(number)!.mergeable = false;
      assert.match((await api(ctx.port, "POST", "tasks/odd/approve", { force: true })).data.error, /conflicts with main/);
      github.pulls.get(number)!.mergeable = true;

      const elsewhere = tempDir("aso-elsewhere-");
      try {
        git(elsewhere, "clone", "--quiet", "--branch", "task/odd", ctx.originDir!, ".");
        writeFiles(elsewhere, { "o.txt": "changed on GitHub\n" });
        git(elsewhere, "commit", "--quiet", "-am", "a commit made on GitHub");
        git(elsewhere, "push", "--quiet", "origin", "task/odd");
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
      const res = await api(ctx.port, "POST", "tasks/odd/approve", { force: true });
      assert.equal(res.status, 409);
      assert.match(res.data.error, /a commit QA did not test/);
      assert.equal(github.pulls.get(number)!.merged, false);
      dev.ws.close();
      qa.ws.close();
    }));

  it("sends requested changes back to an agent as a review round, and says so on the pull request", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("greet"));
      await implementAndPass(ctx, dev, qa, "greet", { "greeting.txt": "hello\n" });
      const number = (await reviewed(ctx, "greet")).review!.pr!.number;

      passedAcceptance(ctx, "greet");
      assert.equal((await api(ctx.port, "POST", "tasks/greet/request-changes", { message: "   " })).status, 400);
      assert.equal((await api(ctx.port, "POST", "tasks/greet/request-changes", {})).status, 400);
      const res = await api(ctx.port, "POST", "tasks/greet/request-changes", { message: "Say hello politely.\nAnd end with a full stop." });
      assert.equal(res.status, 200, res.data.error);
      assert.ok(["pending", "assigned"].includes(res.data.state), res.data.state);

      const back = await dev.next();
      assert.ok(back.type === "TASK_ASSIGNMENT" && back.payload.rework);
      assert.equal(back.payload.rework.reason, "Review round 1: a person asked for changes: Say hello politely.");
      assert.equal(back.payload.rework.output, "What the reviewer asked for:\nSay hello politely.\nAnd end with a full stop.");
      const t = ctx.hub.tasks.get("greet")!;
      assert.deepEqual([t.reworkRound, t.review!.rounds], [0, 1], "a review round, not a rework round");
      assert.equal(overturnedOf(ctx, "greet"), "changesRequested");
      await waitFor(() => github.pulls.get(number)!.comments.length > 0, 5000, "comment on the PR");
      assert.equal(
        github.pulls.get(number)!.comments.at(-1),
        "**Changes requested in ASO:**\n\n> Say hello politely.\n> And end with a full stop.\n\nThe task went back to an agent; its next commit comes to this pull request.",
      );
      assert.equal((await api(ctx.port, "POST", "tasks/greet/request-changes", { message: "again" })).status, 409, "no longer under review");
      assert.equal((await api(ctx.port, "GET", "tasks/greet/checks")).status, 409);
      dev.ws.close();
      qa.ws.close();
    }));

  it("answers 404 for unknown tasks and 409 for tasks without a pull request", () =>
    withGitHub(
      async (ctx) => {
        for (const [method, path] of [["GET", "diff"], ["GET", "checks"], ["POST", "approve"], ["POST", "request-changes"]] as const) {
          const res = await api(ctx.port, method, `tasks/nope/${path}`, method === "POST" ? { message: "x" } : undefined);
          assert.equal(res.status, 404, path);
        }
        const dev = await worker(ctx.port, "dev");
        const qa = await worker(ctx.port, "qa");
        await postTask(ctx.port, task("plain"));
        assert.equal((await api(ctx.port, "GET", "tasks/plain/diff")).status, 409, "no commit yet");
        await implementAndPass(ctx, dev, qa, "plain", { "p.txt": "p\n" });
        await waitFor(() => ctx.hub.tasks.get("plain")?.state === "merged", 10_000, "merged on the Hub");
        const res = await api(ctx.port, "POST", "tasks/plain/approve");
        assert.equal(res.status, 409);
        assert.match(res.data.error, /is merged, not waiting for review/);
        dev.ws.close();
        qa.ws.close();
      },
      { pullRequests: { enabled: false } },
    ));
});

describe("pull request helpers", () => {
  it("sums up checks: failing beats unreadable beats pending beats passing", () => {
    const run = (name: string, conclusion: string | null) => ({ name, status: conclusion ? "completed" : "queued", conclusion });
    assert.deepEqual(
      ["success", "neutral", "skipped", "failure", "cancelled", "timed_out", "action_required", null].map((c) => checkState(run("x", c))),
      ["passing", "skipped", "skipped", "failing", "failing", "failing", "failing", "pending"],
    );
    assert.deepEqual(["success", "pending", "failure", "error"].map((state) => checkState({ state })), ["passing", "pending", "failing", "failing"]);

    const status = (context: string, state: string) => ({ context, state });
    assert.equal(summarizeChecks([], []).overall, "none");
    assert.equal(summarizeChecks([run("a", "success"), run("b", "skipped")], []).overall, "passing");
    assert.equal(summarizeChecks([run("a", "success")], [status("ci", "pending")]).overall, "pending");
    assert.equal(summarizeChecks([run("a", null)], [status("ci", "failure")]).overall, "failing");
    const forbidden = new GitHubError("HTTP 403", 403);
    const unknown = summarizeChecks([run("a", "success")], forbidden);
    assert.equal(unknown.overall, "unknown", "a passing run says nothing about the statuses nobody could read");
    assert.match(unknown.error!, /read access to Actions and Commit statuses/);
    assert.equal(summarizeChecks([run("a", "failure")], forbidden).overall, "failing");
    assert.equal(summarizeChecks(new Error("GitHub unreachable"), []).error, "GitHub unreachable");
    assert.deepEqual(summarizeChecks([], [{ context: "ci", state: "success", url: "u" }]).checks, [{ name: "ci", state: "passing", url: "u" }]);
  });

  it("merges only the tested commit, without conflicts, and with passing checks unless forced", () => {
    const checks = (overall: any, extra: Record<string, unknown> = {}) => ({
      pr: { number: 3, url: "u" }, headSha: "abc", mergeable: true, overall, checks: [{ name: "e2e", state: "failing" as const }], ...extra,
    });
    assert.equal(mergeBlock(checks("passing"), "abc"), undefined);
    assert.equal(mergeBlock(checks("none"), "abc"), undefined);
    assert.equal(mergeBlock(checks("failing"), "abc"), "checks failing: e2e; approve with force to merge anyway");
    assert.equal(mergeBlock(checks("failing"), "abc", true), undefined);
    assert.match(mergeBlock(checks("unknown", { error: "no access" }), "abc")!, /^checks can't be read \(no access\)/);
    assert.match(mergeBlock(checks("passing"), "older", true)!, /commit QA did not test/, "force never skips the tested commit");
    assert.match(mergeBlock(checks("passing", { mergeable: false }), "abc", true)!, /conflicts with main/);
    assert.equal(mergeBlock(checks("passing", { mergeable: null }), "abc"), undefined, "GitHub still working it out: its merge decides");
  });

  it("splits a diff into files, and leaves out patches that would make it too big", () => {
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/a.txt",
      "@@ -0,0 +1 @@",
      "+a",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "@@ -1,2 +0,0 @@",
      "-x",
      "-y",
      "diff --git a/my file.txt b/my file.txt",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "",
    ].join("\n");
    const numstat = "1\t0\ta.txt\0-\t-\timg.png\0" + "0\t2\told.txt\0" + "1\t1\tmy file.txt\0";
    const { files, truncated } = parseDiff(numstat, patch);
    assert.equal(truncated, false);
    assert.deepEqual(
      files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary, f.patch?.split("\n").length]),
      [["a.txt", "added", 1, 0, false, 6], ["img.png", "modified", 0, 0, true, undefined], ["old.txt", "deleted", 0, 2, false, 5], ["my file.txt", "modified", 1, 1, false, 4]],
    );
    assert.ok(files[3].patch!.endsWith("+2"), "no trailing newline");

    const small = parseDiff(numstat, patch, { file: 80, total: 1000 });
    assert.equal(small.truncated, true);
    assert.deepEqual(small.files.map((f) => !!f.patch), [false, false, true, true], "only the big file loses its patch");
    const budget = parseDiff(numstat, patch, { file: 1000, total: 100 });
    assert.deepEqual(budget.files.map((f) => !!f.patch), [true, false, false, false], "the budget runs out after the first");
    assert.deepEqual(parseDiff("", ""), { files: [], truncated: false });
  });

  it("recognises GitHub remotes only", () => {
    for (const url of ["https://github.com/me/shop.git", "https://github.com/me/shop", "https://x-access-token:t@github.com/me/shop.git", "git@github.com:me/shop.git", "ssh://git@github.com/me/shop.git"]) {
      assert.deepEqual(parseGitHubRemote(url), SLUG, url);
    }
    for (const url of ["https://gitlab.com/me/shop.git", "/srv/git/shop.git", "https://github.com/me", "https://github.com.evil.example/me/shop.git"]) {
      assert.equal(parseGitHubRemote(url), undefined, url);
    }
  });

  it("acts on the newest decision about the current commit, once", () => {
    const r = (id: number, state: string, commit = "head", author = "a") => ({ id, state, body: "", author, commit });
    const pull = { headSha: "head", author: "me" };
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED")], pull, [])?.id, 1);
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED")], pull, [1]), undefined, "handled");
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED", "old")], pull, []), undefined, "about an older commit");
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED"), r(2, "APPROVED")], pull, []), undefined, "approved since");
    assert.equal(changesRequested([r(1, "APPROVED"), r(2, "COMMENTED"), r(3, "CHANGES_REQUESTED")], pull, [])?.id, 3);
    assert.equal(changesRequested([r(1, "COMMENTED", "head", "me")], pull, [])?.id, 1, "on your own PR, a Comment review is the way to ask");
    assert.equal(changesRequested([r(1, "COMMENTED", "head", "someone")], pull, []), undefined, "someone else's comment is not a decision");
    assert.equal(changesRequested([r(1, "COMMENTED", "head", "me"), r(2, "APPROVED", "head", "boss")], pull, []), undefined, "approved since");
  });

  it("turns a review into the agent's reason and details", () => {
    const review = { id: 1, state: "CHANGES_REQUESTED", body: "", author: "ana", commit: "h" };
    const f = reviewFeedback(review, [{ path: "a.ts", line: 3, body: " no " }, { path: "b.ts", body: "rename" }]);
    assert.equal(f.summary, "ana asked for changes on GitHub: see the comments on the code");
    assert.equal(f.details, "Review by ana:\n(no summary)\n\nComments on the code:\n- a.ts:3: no\n- b.ts: rename");
    assert.ok(reviewFeedback({ ...review, body: "x".repeat(10_000) }, []).summary.length <= 4000);
  });

  it("describes the task in the pull request", () => {
    const t = {
      spec: { taskId: "t1", role: "frontend", kind: "implementation", title: "T", description: "Do it.", acceptanceCriteria: [], dependsOn: [] },
      filesTouched: ["a.ts"],
      qaSummary: "ok",
      reworkRound: 2,
      review: { rounds: 1, handled: [] },
      llm: { costUsd: 1.234 },
    } as unknown as TaskRecord;
    const body = pullRequestBody(t);
    assert.match(body, /^Do it\.\n\n\*\*Files\*\* \(1\)\n- `a\.ts`/);
    assert.match(body, /\*\*Task:\*\* `t1` \(frontend, implementation\), after 2 rework rounds and 1 review round; model cost about \$1\.23/);
    assert.doesNotMatch(body, /Acceptance criteria/);
    assert.doesNotMatch(body, /What the agent did/, "no summary, no heading");
    const told = pullRequestBody({ ...t, summary: "  Changed a.ts; tests pass.\n" } as TaskRecord);
    assert.match(told, /^Do it\.\n\n\*\*What the agent did\*\*\n\nChanged a\.ts; tests pass\.\n\n\*\*Files\*\* \(1\)/);
  });
});

describe("projects connected to GitHub", () => {
  /** A Hub with a projects root whose GitHub repository me/shop is the bare repository `origin`. */
  async function withGitHubRoot(fn: (port: number, root: string, origin: string) => Promise<void>, opts: { token?: string | null } = {}) {
    const root = tempDir("aso-projects-");
    const origin = tempDir("aso-github-shop-");
    git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
    github.reset(origin);
    const token = opts.token === null ? undefined : (opts.token ?? GH_TOKEN);
    const hub = await startHub({
      projectsRoot: root,
      port: 0,
      host: "127.0.0.1",
      token: TOKEN,
      sync: { token },
      pullRequests: { apiUrl: github.url, repo: SLUG, pollMs: 60_000, gitUrl: () => origin },
    });
    try {
      await fn(hub.port, root, origin);
    } finally {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  }

  it("connects an empty repository: pushes the first commit, and pull requests are on", () =>
    withGitHubRoot(async (port, root, origin) => {
      const res = await api(port, "POST", "projects", { name: "shop", github: "https://github.com/me/shop" });
      assert.equal(res.status, 201, res.data.error);
      assert.deepEqual(res.data.pullRequests, { enabled: true, repo: "me/shop" });
      assert.equal(git(origin, "log", "--format=%s", "main"), "Initial commit", "the first commit is on GitHub");
      assert.equal(git(`${root}/shop`, "remote", "get-url", "origin"), origin);
      assert.doesNotMatch(readFileSync(`${root}/shop/.git/config`, "utf8"), /extraHeader|Authorization/i, "the token is never stored");
    }));

  it("clones a repository that already has code", () =>
    withGitHubRoot(async (port, root, origin) => {
      const seed = tempDir("aso-seed-");
      try {
        git(seed, "clone", "--quiet", origin, ".");
        writeFiles(seed, { "README.md": "# Shop\n" });
        git(seed, "add", "-A");
        git(seed, "-c", "user.name=Me", "-c", "user.email=me@example.com", "commit", "--quiet", "-m", "existing code");
        git(seed, "push", "--quiet", "origin", "HEAD:main");
      } finally {
        rmSync(seed, { recursive: true, force: true });
      }
      const res = await api(port, "POST", "projects", { name: "shop", github: "me/shop" });
      assert.equal(res.status, 201, res.data.error);
      assert.equal(git(`${root}/shop`, "show", "main:README.md"), "# Shop");
      assert.equal(git(`${root}/shop`, "rev-parse", "main"), git(origin, "rev-parse", "main"));
    }));

  it("says what to fix when the repository can't be used, and leaves nothing behind", () =>
    withGitHubRoot(async (port, root) => {
      const fails = async (github: string, error: RegExp) => {
        const res = await api(port, "POST", "projects", { name: "shop", github });
        assert.equal(res.status, 400, github);
        assert.match(res.data.error, error);
        assert.equal(existsSync(`${root}/shop`), false, "no folder left behind");
      };
      await fails("not a repo", /not a GitHub repository: use owner\/repo/);
      await fails("me/other", /token can't reach me\/other: create the repository on GitHub, then add it to the token's repository access/);
      github.repoInfo = { default_branch: "main", permissions: { push: false } };
      await fails("me/shop", /can read me\/shop but not write to it/);
      github.repoInfo = { default_branch: "master", permissions: { push: true } };
      await fails("me/shop", /default branch is master; the Hub works on main/);
      assert.equal((await api(port, "POST", "projects", { name: "plain" })).status, 201, "a project without GitHub still works");
    }));

  it("needs the Hub's GitHub token to connect one", () =>
    withGitHubRoot(
      async (port) => {
        const res = await api(port, "POST", "projects", { name: "shop", github: "me/shop" });
        assert.equal(res.status, 400);
        assert.match(res.data.error, /needs the Hub's GitHub token \(ASO_GIT_TOKEN\)/);
      },
      { token: null },
    ));

  it("reads owner/repo and github.com URLs", () => {
    for (const input of ["me/shop", " me/shop.git ", "https://github.com/me/shop", "git@github.com:me/shop.git"]) {
      assert.deepEqual(parseGitHubRepo(input), SLUG, input);
    }
    for (const input of ["shop", "me/shop/extra", "https://gitlab.com/me/shop", "../me/shop"]) assert.equal(parseGitHubRepo(input), undefined, input);
  });
});
