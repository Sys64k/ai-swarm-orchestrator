import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { changesRequested, parseGitHubRemote, pullRequestBody, reviewFeedback, startHub, type TaskRecord } from "@aso/hub";
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
    if (rest === "/reviews" && req.method === "GET") return [200, pull.reviews];
    const rc = /^\/reviews\/(\d+)\/comments$/.exec(rest);
    if (rc && req.method === "GET") return [200, pull.reviewComments.get(Number(rc[1])) ?? []];
    return [404, { message: "Not Found" }];
  }

  /** A person reviews the PR's current commit. */
  review(number: number, state: "CHANGES_REQUESTED" | "APPROVED" | "COMMENTED", text: string, comments: Array<{ path: string; line: number; body: string }> = []): number {
    const pull = this.pulls.get(number)!;
    const id = 100 + pull.reviews.length + number * 1000;
    pull.reviews.push({ id, state, body: text, user: { login: "reviewer" }, commit_id: this.headSha(pull.head) });
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
async function implementAndPass(ctx: HubContext, dev: TestClient, qa: TestClient, taskId: string, files: Record<string, string>): Promise<string> {
  const assignment = await dev.next();
  assert.ok(assignment.type === "TASK_ASSIGNMENT" && assignment.payload.taskId === taskId, `assigned ${taskId}`);
  dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId }));
  const commit = await pushTaskBranch(ctx.gitUrl, taskId, files);
  dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId, commit }));
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

const reviewed = (ctx: HubContext, taskId: string) =>
  waitFor(() => {
    const t = ctx.hub.tasks.get(taskId);
    return t?.state === "awaiting_review" && t.review?.pr && t;
  }, 10_000, `${taskId} awaiting review with a PR`);

describe("pull requests on GitHub", () => {
  it("opens a pull request after QA instead of merging, and merges into the Hub's main once merged on GitHub", () =>
    withGitHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { slots: 2 });
      const qa = await worker(ctx.port, "qa");
      const mainBefore = git(ctx.repoDir, "rev-parse", "main");
      await postTask(ctx.port, task("greet", { acceptanceCriteria: ["says hello"] }));
      await postTask(ctx.port, task("follow", { dependsOn: ["greet"] }));
      const commit = await implementAndPass(ctx, dev, qa, "greet", { "greeting.txt": "hello\n" });

      const t = await reviewed(ctx, "greet");
      assert.equal(git(ctx.originDir!, "rev-parse", "refs/heads/task/greet"), commit, "the branch is on GitHub");
      assert.equal(git(ctx.repoDir, "rev-parse", "main"), mainBefore, "nothing merged on the Hub");
      const pull = github.pulls.get(t.review!.pr!.number)!;
      assert.deepEqual([pull.title, pull.head, pull.base], ["Task greet", "task/greet", "main"]);
      assert.match(pull.body, /Build greet\./);
      assert.match(pull.body, /- says hello/);
      assert.match(pull.body, /\*\*QA:\*\* 12 tests passed/);
      assert.match(pull.body, /\*\*Request changes\*\* to send it back/);
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

      github.review(number, "COMMENTED", "just a thought");
      await ctx.hub.projects.checkReviews("project");
      assert.equal(ctx.hub.tasks.get("greet")!.state, "awaiting_review", "a comment is not a decision");

      github.review(number, "CHANGES_REQUESTED", "Say hello politely.", [{ path: "greeting.txt", line: 1, body: "Use 'Hello there'" }]);
      await ctx.hub.projects.checkReviews("project");
      const back = await dev.next();
      assert.ok(back.type === "TASK_ASSIGNMENT" && back.payload.rework);
      assert.equal(back.payload.rework.round, 1);
      assert.match(back.payload.rework.reason, /^Review round 1: reviewer requested changes on GitHub: Say hello politely\.$/);
      assert.match(back.payload.rework.output ?? "", /- greeting\.txt:1: Use 'Hello there'/);
      const t = ctx.hub.tasks.get("greet")!;
      assert.deepEqual([t.reworkRound, t.review!.rounds], [0, 1], "review rounds do not count towards the rework limit");

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
      github.pulls.get(first)!.state = "closed";
      await ctx.hub.projects.checkReviews("project");
      assert.equal(ctx.hub.tasks.get("one")!.state, "cancelled");

      await postTask(ctx.port, task("two"));
      await implementAndPass(ctx, dev, qa, "two", { "two.txt": "2\n" });
      const second = (await reviewed(ctx, "two")).review!.pr!.number;
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/tasks/two/cancel`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(res.status, 200);
      await waitFor(() => github.pulls.get(second)!.state === "closed", 5000, "PR closed");
      assert.match(github.pulls.get(second)!.comments.at(-1)!, /cancelled from the ASO console/);
      dev.ws.close();
      qa.ws.close();
    }));

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

describe("pull request helpers", () => {
  it("recognises GitHub remotes only", () => {
    for (const url of ["https://github.com/me/shop.git", "https://github.com/me/shop", "https://x-access-token:t@github.com/me/shop.git", "git@github.com:me/shop.git", "ssh://git@github.com/me/shop.git"]) {
      assert.deepEqual(parseGitHubRemote(url), SLUG, url);
    }
    for (const url of ["https://gitlab.com/me/shop.git", "/srv/git/shop.git", "https://github.com/me", "https://github.com.evil.example/me/shop.git"]) {
      assert.equal(parseGitHubRemote(url), undefined, url);
    }
  });

  it("acts on the newest decision about the current commit, once", () => {
    const r = (id: number, state: string, commit = "head") => ({ id, state, body: "", author: "a", commit });
    const pull = { headSha: "head" };
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED")], pull, [])?.id, 1);
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED")], pull, [1]), undefined, "handled");
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED", "old")], pull, []), undefined, "about an older commit");
    assert.equal(changesRequested([r(1, "CHANGES_REQUESTED"), r(2, "APPROVED")], pull, []), undefined, "approved since");
    assert.equal(changesRequested([r(1, "APPROVED"), r(2, "COMMENTED"), r(3, "CHANGES_REQUESTED")], pull, [])?.id, 3);
  });

  it("turns a review into the agent's reason and details", () => {
    const review = { id: 1, state: "CHANGES_REQUESTED", body: "", author: "ana", commit: "h" };
    const f = reviewFeedback(review, [{ path: "a.ts", line: 3, body: " no " }, { path: "b.ts", body: "rename" }]);
    assert.equal(f.summary, "ana requested changes on GitHub: see the comments on the code");
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
  });
});
