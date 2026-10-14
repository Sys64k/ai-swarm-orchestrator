import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { startHub, type HubHandle } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import { connect, git, gitAsync, makeTargetRepo, pushTaskBranch, tempDir, TOKEN, waitFor, worker, writeFiles } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY;

const call = (port: number, route: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

/** A projects root with `shop` and `blog` repositories, plus folders that are not projects. */
function projectsRoot(): string {
  const root = tempDir("aso-root-");
  for (const name of ["shop", "blog"]) {
    const repo = makeTargetRepo({ [`${name}.txt`]: name });
    git(root, "clone", "--quiet", repo, name);
    rmSync(repo, { recursive: true, force: true });
  }
  mkdirSync(path.join(root, "notes")); // not a git repository
  mkdirSync(path.join(root, "My Project")); // not a valid project name
  writeFiles(path.join(root, "My Project"), { "x.txt": "x" });
  return root;
}

async function withRoot(fn: (hub: HubHandle, root: string) => Promise<void>, root = projectsRoot()) {
  const hub = await startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false } });
  try {
    await fn(hub, root);
  } finally {
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const task = (taskId: string, project?: string, extra: Record<string, unknown> = {}) => ({
  taskId,
  project,
  role: "backend",
  title: taskId,
  description: "x",
  ...extra,
});

describe("projects", () => {
  it("shows the host path of the projects folder when the Hub runs in Docker", async () => {
    const root = projectsRoot();
    const hub = await startHub({ projectsRoot: root, projectsRootDisplay: "/home/me/aso-projects", port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false } });
    try {
      assert.equal((await call(hub.port, "/api/health")).body.projectsRoot, "/home/me/aso-projects");
      assert.equal((await call(hub.port, "/api/projects/shop")).body.dir, "/home/me/aso-projects/shop");
    } finally {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds the git repositories in the root and creates new ones", () =>
    withRoot(async (hub, root) => {
      const list = await call(hub.port, "/api/projects");
      assert.deepEqual(list.body.map((p: { id: string }) => p.id), ["blog", "shop"], "only valid git repositories");

      const created = await call(hub.port, "/api/projects", { name: "notes-app" });
      assert.equal(created.status, 201);
      assert.equal(created.body.id, "notes-app");
      assert.equal(git(path.join(root, "notes-app"), "log", "--format=%s", "main"), "Initial commit");
      assert.equal((await call(hub.port, "/api/projects")).body.length, 3);

      assert.equal((await call(hub.port, "/api/projects", { name: "shop" })).status, 409);
      assert.equal((await call(hub.port, "/api/projects", { name: "notes" })).status, 409, "an existing folder is never taken over");
      assert.equal((await call(hub.port, "/api/projects", { name: "Bad Name" })).status, 400);
      assert.equal((await call(hub.port, "/api/projects", { name: "../escape" })).status, 400);
      assert.ok(!existsSync(path.join(root, "..", "escape")));

      const health = await call(hub.port, "/api/health");
      assert.equal(health.body.projectsRoot, root);
      assert.deepEqual(health.body.projects, ["blog", "shop", "notes-app"]);
    }));

  it("needs a project when there are several, and keeps task ids unique across them", () =>
    withRoot(async (hub) => {
      const missing = await call(hub.port, "/api/tasks", task("api"));
      assert.equal(missing.status, 400);
      assert.match(missing.body.error, /say which project/);
      assert.equal((await call(hub.port, "/api/tasks", task("api", "nope"))).status, 404);

      assert.equal((await call(hub.port, "/api/tasks", task("api", "shop"))).body.project, "shop");
      const clash = await call(hub.port, "/api/tasks", task("api", "blog"));
      assert.equal(clash.status, 409, "the id is taken in another project");

      const generated = await call(hub.port, "/api/tasks", { project: "blog", role: "backend", title: "api", description: "x" });
      assert.match(generated.body.spec.taskId, /^api-[0-9a-f]{6}$/);

      const blogOnly = await call(hub.port, "/api/tasks?project=blog");
      assert.deepEqual(blogOnly.body.map((t: { project: string }) => t.project), ["blog"]);
      assert.equal((await call(hub.port, "/api/tasks")).body.length, 2);

      // Ids are global, so a task is reachable without naming its project.
      assert.equal((await call(hub.port, "/api/tasks/api")).body.project, "shop");
      assert.equal((await call(hub.port, "/api/tasks/api/cancel", {})).body.state, "cancelled");

      // Dependencies stay within a project.
      const crossDep = await call(hub.port, "/api/tasks", task("ui", "blog", { dependsOn: ["api"] }));
      assert.equal(crossDep.status, 400);
    }));

  it("serves each project's repository at its own Git URL", () =>
    withRoot(async (hub) => {
      const url = (p: string) => `http://127.0.0.1:${hub.port}/git/${p}.git`;
      await call(hub.port, "/api/tasks", task("shop-api", "shop"));
      await pushTaskBranch(url("shop"), "shop-api", { "api.ts": "x" });
      assert.ok(git(hub.projects.get("shop")!.dir, "branch", "--list", "task/shop-api"));
      assert.equal(git(hub.projects.get("blog")!.dir, "branch", "--list", "task/shop-api"), "", "other projects are untouched");

      const clone = tempDir();
      try {
        await gitAsync(clone, "clone", "--quiet", url("blog"), ".");
        assert.ok(existsSync(path.join(clone, "blog.txt")));
      } finally {
        rmSync(clone, { recursive: true, force: true });
      }
      const missing = await fetch(`${url("nope")}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(missing.status, 404);
    }));

  it("shares workers across projects and tells them which project to check out", () =>
    withRoot(async (hub) => {
      const w = await worker(hub.port, "dev", { roles: ["backend"] });
      await call(hub.port, "/api/tasks", task("shop-1", "shop"));
      const first = await w.next();
      assert.ok(first.type === "TASK_ASSIGNMENT" && first.payload.project === "shop");

      await call(hub.port, "/api/tasks", task("blog-1", "blog"));
      assert.ok(await w.quiet(), "busy: the blog task waits");
      assert.equal(hub.tasks.get("blog-1")!.state, "pending");

      // Finishing work in one project frees the worker for the other.
      w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "shop-1", detail: "x" }));
      const second = await w.next();
      assert.ok(second.type === "TASK_ASSIGNMENT" && second.payload.taskId === "blog-1" && second.payload.project === "blog");
      w.ws.close();
    }));

  it("sends plans to the Architect with their project and creates the tasks there", () =>
    withRoot(async (hub) => {
      const plan = await call(hub.port, "/api/plans", { requirement: "Add comments", project: "blog" });
      assert.equal(plan.body.project, "blog");
      assert.equal((await call(hub.port, "/api/plans", { requirement: "x" })).status, 400, "which project?");

      const arch = await connect(hub.port);
      arch.send(createMessage("NODE_REGISTRATION", "arch", { nodeKind: "architect", version: "test" }));
      assert.equal((await arch.next()).type, "REGISTRATION_ACK");
      const req = (await arch.next()) as AgentMessage;
      assert.ok(req.type === "PLAN_REQUEST" && req.payload.project === "blog");
      arch.send(createMessage("PLAN_RESULT", "arch", {
        planId: plan.body.planId,
        outcome: "proposed",
        summary: "s",
        tasks: [{ key: "comments", role: "backend", kind: "feature", title: "Comments", description: "d", acceptanceCriteria: [], files: [], dependsOn: [] }],
      }));
      await waitFor(async () => (await call(hub.port, `/api/plans/${plan.body.planId}`)).body.state === "proposed");
      const approved = await call(hub.port, `/api/plans/${plan.body.planId}/approve`, {});
      const taskId = approved.body.taskIds.comments;
      assert.equal(hub.tasks.get(taskId)!.project, "blog");
      assert.deepEqual((await call(hub.port, "/api/tasks?project=shop")).body, []);
      arch.ws.close();
    }));

  it("keeps each project's tasks in that project across a restart", async () => {
    const root = projectsRoot();
    const start = () => startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false } });
    let hub: HubHandle | undefined;
    try {
      hub = await start();
      await call(hub.port, "/api/tasks", task("shop-1", "shop"));
      await call(hub.port, "/api/tasks", task("blog-1", "blog"));
      await hub.close();
      hub = undefined;
      assert.ok(existsSync(path.join(root, "shop", ".git", "aso", "state.json")));
      assert.ok(existsSync(path.join(root, "blog", ".git", "aso", "state.json")));
      // Hub-wide state lives in .aso, which is never mistaken for a project.
      mkdirSync(path.join(root, ".aso", "conversations"), { recursive: true });

      hub = await start();
      assert.equal(hub.tasks.get("shop-1")!.project, "shop");
      assert.equal(hub.tasks.get("blog-1")!.project, "blog");
      assert.deepEqual(hub.projects.list().map((p) => p.id), ["blog", "shop"]);
    } finally {
      await hub?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
