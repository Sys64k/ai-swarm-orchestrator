import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { rmSync } from "node:fs";
import { budgetSpent, describeScope, mayUseProject, projectOfGitPath, REFUSE_ALL, refuseJob, startHub, WorkerKeys, type HubHandle } from "@aso/hub";
import { git, makeTargetRepo, postTask, tempDir, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

const trusted = { trusted: true, spentUsd: 0 };

describe("what a worker key may do", () => {
  it("keeps a key to its projects", () => {
    const scope = { ...trusted, projects: ["aso-ui"] };
    assert.equal(mayUseProject(scope, "aso-ui"), true);
    assert.equal(mayUseProject(scope, "aso-test"), false);
    assert.equal(mayUseProject({ ...trusted }, "anything"), true, "no list: all projects");
    assert.equal(mayUseProject(undefined, "anything"), true, "the Hub's own token");
    assert.equal(refuseJob(scope, { project: "aso-test", job: "implement" }), "its key is limited to aso-ui");
  });

  it("lets an untrusted machine build but not test others' work", () => {
    const untrusted = { trusted: false, spentUsd: 0 };
    assert.equal(refuseJob(untrusted, { project: "p", job: "implement" }), undefined);
    assert.equal(refuseJob(untrusted, { project: "p", job: "test" }), "an untrusted machine doesn't run QA");
    assert.equal(refuseJob(trusted, { project: "p", job: "test" }), undefined);
    assert.equal(refuseJob(undefined, { project: "p", job: "test" }), undefined, "the Hub's own token is fully trusted");
  });

  it("stops a key's jobs once its budget is spent", () => {
    assert.equal(budgetSpent({ ...trusted, budgetUsd: 10, spentUsd: 9.99 }), undefined);
    assert.equal(budgetSpent({ ...trusted, budgetUsd: 10, spentUsd: 10 }), "this machine's model budget ($10) is used up");
    assert.equal(budgetSpent({ ...trusted, spentUsd: 500 }), undefined, "no budget: no cap");
    assert.equal(refuseJob({ ...trusted, budgetUsd: 0 }, { project: "p", job: "implement" }), "this machine's model budget ($0) is used up");
  });

  it("refuses everything to a machine whose key is gone", () => {
    assert.equal(mayUseProject(REFUSE_ALL, "any"), false);
    assert.ok(refuseJob(REFUSE_ALL, { project: "any", job: "implement" }));
    assert.ok(budgetSpent(REFUSE_ALL));
  });

  it("finds the project in a Git path, and nothing in a path that isn't one", () => {
    assert.equal(projectOfGitPath("/git/aso-ui.git/info/refs", "/git"), "aso-ui");
    assert.equal(projectOfGitPath("/git/aso-ui.git", "/git"), "aso-ui");
    assert.equal(projectOfGitPath("/git/a.b_c-d.git/git-upload-pack", "/git"), "a.b_c-d");
    for (const odd of ["/git/", "/git/aso-ui", "/git/aso-ui.gitx/info", "/git/../x.git/info", "/git/%2e%2e.git/info", "/other/aso-ui.git/info", "/gitx/aso-ui.git"]) {
      assert.equal(projectOfGitPath(odd, "/git"), undefined, odd);
    }
  });

  it("describes a scope", () => {
    assert.equal(describeScope({ trusted: false, projects: ["aso-ui"], budgetUsd: 10, spentUsd: 1.2 }), "untrusted, projects aso-ui, $1.20 of $10 spent");
    assert.equal(describeScope(trusted), "trusted, all projects");
  });
});

describe("worker keys with a scope", () => {
  it("gives a key its join code's scope, changes it, and counts its spending", async () => {
    const dir = tempDir();
    const keys = await WorkerKeys.open(dir);
    const { code } = keys.createJoinCode("friend", Date.now(), { projects: ["aso-ui"], trusted: false, budgetUsd: 5 });
    const joined = (await keys.join(code, "friend-pc"))!;
    assert.deepEqual(keys.scopeOf(joined.id), { projects: ["aso-ui"], trusted: false, budgetUsd: 5, spentUsd: 0 });
    keys.addSpend(joined.id, 1.25, 0);
    keys.addSpend(joined.id, 0.5, 1);
    assert.equal(keys.scopeOf(joined.id)!.spentUsd, 1.75);
    const changed = await keys.setScope(joined.id, { projects: null, trusted: true, budgetUsd: null });
    assert.deepEqual([changed!.projects, changed!.trusted, changed!.budgetUsd, changed!.spentUsd], [undefined, true, undefined, 1.75]);
    assert.equal((await WorkerKeys.open(dir)).scopeOf(joined.id)!.spentUsd, 1.75, "kept across restarts");
    assert.equal(await keys.setScope("nope", { trusted: false }), undefined);
  });

  it("treats a key from before scopes as trusted, for every project", async () => {
    const keys = await WorkerKeys.open();
    const { code } = keys.createJoinCode();
    const joined = (await keys.join(code, "old"))!;
    assert.deepEqual(keys.scopeOf(joined.id), { trusted: true, spentUsd: 0 });
    assert.deepEqual(keys.list()[0].trusted, true);
  });
});

const call = (port: number, route: string, body?: unknown, auth: string | null = TOKEN) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));

async function joinWith(port: number, scope: Record<string, unknown>) {
  const code = (await call(port, "/api/worker-keys/join-codes", { name: "friend", ...scope })).body.code as string;
  return (await call(port, "/api/worker-keys/join", { code, machine: "friend-pc" }, null)).body as { id: string; key: string };
}

const clone = (port: number, key: string, project = "project") =>
  promisify(execFile)("git", ["clone", "--quiet", `http://x-access-token:${key}@127.0.0.1:${port}/git/${project}.git`, "."], {
    cwd: tempDir(),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

/** A Hub with two projects, shop and blog. */
async function withTwoProjects(fn: (port: number, hub: HubHandle) => Promise<void>) {
  const root = tempDir("aso-root-");
  for (const name of ["shop", "blog"]) {
    const repo = makeTargetRepo({ [`${name}.txt`]: name });
    git(root, "clone", "--quiet", repo, name);
    rmSync(repo, { recursive: true, force: true });
  }
  const hub = await startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false } });
  try {
    await fn(hub.port, hub);
  } finally {
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("worker key scopes (Hub)", () => {
  it("keeps a machine to its key's projects: no jobs and no Git elsewhere, until its scope widens", async () => {
    await withTwoProjects(async (port, hub) => {
      assert.equal((await call(port, "/api/worker-keys/join-codes", { projects: ["nope"] })).status, 400, "an unknown project");
      const friend = await joinWith(port, { projects: ["blog"] });
      assert.ok(friend.key, "joined with a key for blog only");

      await assert.rejects(clone(port, friend.key, "shop"), "no Git for another project");
      await clone(port, friend.key, "blog");
      const w = await worker(port, "friend-pc", { token: friend.key });
      assert.equal((await call(port, "/api/tasks", { taskId: "t1", project: "shop", role: "backend", title: "T", description: "d" })).status, 201);
      await waitFor(() => /its key is limited to blog/.test(hub.tasks.get("t1")?.waitingReason ?? ""));
      assert.equal(hub.tasks.get("t1")!.state, "pending", "not given to it");

      const widened = await call(port, `/api/worker-keys/${friend.id}`, { projects: null });
      assert.equal(widened.status, 200, JSON.stringify(widened.body));
      assert.equal(widened.body.projects, undefined);
      await waitFor(() => hub.tasks.get("t1")?.state === "assigned");
      assert.equal((await w.next()).type, "TASK_ASSIGNMENT", "the job goes to it once allowed");
      await clone(port, friend.key, "shop");
      w.ws.close();
    });
  });

  it("shows and changes a key's scope over the API, and refuses bad changes", async () => {
    await withHub(async (ctx) => {
      const friend = await joinWith(ctx.port, { trusted: false, budgetUsd: 2.5 });
      const listed = (await call(ctx.port, "/api/worker-keys")).body.find((k: { id: string }) => k.id === friend.id);
      assert.deepEqual([listed.trusted, listed.budgetUsd, listed.spentUsd], [false, 2.5, 0]);
      assert.equal((await call(ctx.port, `/api/worker-keys/${friend.id}`, { projects: ["nope"] })).status, 400);
      assert.equal((await call(ctx.port, `/api/worker-keys/${friend.id}`, { budgetUsd: -1 })).status, 400);
      assert.equal((await call(ctx.port, "/api/worker-keys/nope", { trusted: true })).status, 404);
      const trustedNow = await call(ctx.port, `/api/worker-keys/${friend.id}`, { trusted: true, budgetUsd: null });
      assert.deepEqual([trustedNow.body.trusted, trustedNow.body.budgetUsd], [true, undefined]);
    });
  });

  it("gives a machine whose budget is spent no jobs", async () => {
    await withHub(async (ctx) => {
      const broke = await joinWith(ctx.port, { budgetUsd: 0 });
      const w = await worker(ctx.port, "friend-pc", { token: broke.key });
      await postTask(ctx.port, { taskId: "t1", role: "backend", title: "T", description: "d" });
      await waitFor(() => /model budget \(\$0\) is used up/.test(ctx.hub.tasks.get("t1")?.waitingReason ?? ""));
      w.ws.close();
    });
  });
});
