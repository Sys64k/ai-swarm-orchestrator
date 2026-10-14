import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { startArchitect } from "@aso/architect";
import { createMessage, type AgentMessage } from "@aso/shared";
import { startWorker, type TaskExecutor } from "@aso/worker";
import {
  connect,
  git,
  hardware,
  lastToolResults,
  postTask,
  pushTaskBranch,
  reply,
  ScriptedModel,
  tempDir,
  toolUse,
  waitFor,
  withHub,
  worker,
  writeFiles,
  type HubContext,
  TOKEN,
} from "./helpers.ts";

async function api(ctx: HubContext, path: string, init?: RequestInit) {
  const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function fakeArchitect(ctx: HubContext, nodeId = "arch") {
  const c = await connect(ctx.port);
  c.send(createMessage("NODE_REGISTRATION", nodeId, { nodeKind: "architect", version: "t" }));
  assert.equal((await c.next()).type, "REGISTRATION_ACK");
  return c;
}

function planRequest(m: AgentMessage) {
  assert.equal(m.type, "PLAN_REQUEST");
  return m.type === "PLAN_REQUEST" ? m.payload : assert.fail();
}

const planned = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  role: "backend",
  title: `Task ${key}`,
  description: `Do ${key}`,
  ...extra,
});

describe("task dependencies", () => {
  it("starts a task only after its dependencies are merged", () =>
    withHub(
      async (ctx) => {
        const w = await worker(ctx.port, "dev", { roles: ["backend"] });
        await postTask(ctx.port, { taskId: "api", role: "backend", title: "API", description: "d" });
        const page = await postTask(ctx.port, { taskId: "page", role: "backend", title: "Page", description: "d", dependsOn: ["api"] });
        assert.equal(page.status, 201);
        const first = await w.next();
        assert.ok(first.type === "TASK_ASSIGNMENT" && first.payload.taskId === "api");
        assert.match(ctx.hub.tasks.get("page")!.waitingReason!, /waiting for api to be merged/);

        w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "api" }));
        const commit = await pushTaskBranch(ctx.gitUrl, "api", { "api.js": "x\n" });
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "api", commit }));
        const second = await w.next(5000);
        assert.ok(second.type === "TASK_ASSIGNMENT" && second.payload.taskId === "page" && second.payload.dependsOn[0] === "api");
        assert.equal(ctx.hub.tasks.get("api")!.state, "merged");
        w.ws.close();
      },
      { qa: { enabled: false } },
    ));

  it("blocks dependants of a failed task and rejects unknown dependencies", () =>
    withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev", { roles: ["backend"] });
      await postTask(ctx.port, { taskId: "base", role: "backend", title: "Base", description: "d" });
      await postTask(ctx.port, { taskId: "child", role: "backend", title: "Child", description: "d", dependsOn: ["base"] });
      await w.next();
      w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "base", detail: "boom" }));
      await waitFor(() => /blocked: dependency base failed/.test(ctx.hub.tasks.get("child")!.waitingReason ?? ""));
      assert.ok(await w.quiet());
      const bad = await postTask(ctx.port, { taskId: "orphan", role: "backend", title: "O", description: "d", dependsOn: ["nope"] });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /dependency nope does not exist/);
      w.ws.close();
    }));
});

describe("role scope on the Hub", () => {
  it("sends a QA task back when its branch changes feature code", () =>
    withHub(async (ctx) => {
      const w = await worker(ctx.port, "qa1", { roles: ["qa"] });
      await postTask(ctx.port, { taskId: "tests", role: "qa", title: "Tests", description: "d" });
      await w.next();
      w.send(createMessage("STATUS_UPDATE", "qa1", { state: "in_progress", taskId: "tests" }));
      const commit = await pushTaskBranch(ctx.gitUrl, "tests", { "test/a.test.js": "x\n", "src/a.js": "sneaky\n" });
      w.send(createMessage("STATUS_UPDATE", "qa1", { state: "completed", taskId: "tests", commit, detail: "added tests" }));
      const again = await w.next(5000);
      assert.ok(again.type === "TASK_ASSIGNMENT");
      assert.match(again.type === "TASK_ASSIGNMENT" ? again.payload.rework!.reason : "", /outside the qa role's scope: src\/a.js/);
      assert.ok(ctx.hub.tasks.get("tests")!.history.some((h) => /pushed [0-9a-f]{8}: added tests/.test(h.event)), "finish summary recorded");
      w.ws.close();
    }));
});

describe("plans (fake Architect)", () => {
  it("queues a requirement, takes the proposal, and creates linked tasks on approval", () =>
    withHub(async (ctx) => {
      const created = await api(ctx, "/api/plans", { method: "POST", body: JSON.stringify({ requirement: "Build a todo app" }) });
      assert.equal(created.status, 201);
      const planId = created.body.planId as string;
      assert.equal(created.body.state, "pending");

      const arch = await fakeArchitect(ctx);
      const req = planRequest(await arch.next());
      assert.deepEqual(req, { planId, project: "project", requirement: "Build a todo app" });
      assert.equal((await api(ctx, `/api/plans/${planId}`)).body.state, "planning");

      arch.send(
        createMessage("PLAN_RESULT", "arch", {
          planId,
          outcome: "proposed",
          summary: "API first, then UI and tests",
          tasks: [planned("ui", { role: "frontend", dependsOn: ["api"] }), planned("api"), planned("tests", { role: "qa", dependsOn: ["api", "ui"] })],
        }),
      );
      await waitFor(() => ctx.hub.plans.get(planId)?.state === "proposed");
      assert.equal((await postTask(ctx.port, { role: "backend", title: "x", description: "y" })).status, 201, "other work unaffected");

      const approved = await api(ctx, `/api/plans/${planId}/approve`, { method: "POST" });
      assert.equal(approved.status, 200);
      const ids = approved.body.taskIds as Record<string, string>;
      assert.deepEqual(Object.keys(ids).sort(), ["api", "tests", "ui"]);
      for (const [key, id] of Object.entries(ids)) assert.match(id, new RegExp(`^${key}-[0-9a-f]{6}$`));
      assert.deepEqual(ctx.hub.tasks.get(ids.ui)!.spec.dependsOn, [ids.api]);
      assert.deepEqual(ctx.hub.tasks.get(ids.tests)!.spec.dependsOn.sort(), [ids.api, ids.ui].sort());
      assert.equal(ctx.hub.tasks.get(ids.api)!.planId, planId);
      assert.equal((await api(ctx, `/api/plans/${planId}/approve`, { method: "POST" })).status, 409);
      arch.ws.close();
    }));

  it("fails invalid proposals, ignores strangers, requeues on Architect loss, and supports reject", () =>
    withHub(async (ctx) => {
      const a = await fakeArchitect(ctx, "arch-a");
      const p1 = (await api(ctx, "/api/plans", { method: "POST", body: JSON.stringify({ requirement: "one" }) })).body.planId;
      planRequest(await a.next());

      const stranger = await worker(ctx.port, "w", { roles: ["backend"] });
      stranger.send(createMessage("PLAN_RESULT", "w", { planId: p1, outcome: "failed", error: "x" }));
      const rejected = await stranger.next();
      assert.ok(rejected.type === "PROTOCOL_ERROR" && /not being planned by w/.test(rejected.payload.reason));

      a.send(createMessage("PLAN_RESULT", "arch-a", { planId: p1, outcome: "proposed", summary: "s", tasks: [planned("x", { dependsOn: ["x"] })] }));
      await waitFor(() => ctx.hub.plans.get(p1)?.state === "failed");
      assert.match(ctx.hub.plans.get(p1)!.error!, /invalid plan: task "x" depends on itself/);

      const p2 = (await api(ctx, "/api/plans", { method: "POST", body: JSON.stringify({ requirement: "two" }) })).body.planId;
      planRequest(await a.next());
      a.ws.close();
      await a.closed;
      await waitFor(() => ctx.hub.plans.get(p2)?.state === "pending");
      const b = await fakeArchitect(ctx, "arch-b");
      assert.equal(planRequest(await b.next()).planId, p2);
      b.send(createMessage("PLAN_RESULT", "arch-b", { planId: p2, outcome: "proposed", summary: "s", tasks: [planned("x")] }));
      await waitFor(() => ctx.hub.plans.get(p2)?.state === "proposed");
      assert.equal((await api(ctx, `/api/plans/${p2}/reject`, { method: "POST" })).body.state, "rejected");
      assert.equal(ctx.hub.tasks.list().length, 0);

      assert.equal((await api(ctx, "/api/plans", { method: "POST", body: JSON.stringify({ requirement: "" }) })).status, 400);
      assert.equal((await api(ctx, "/api/plans/plan-nope00/approve", { method: "POST" })).status, 404);
      b.ws.close();
      stranger.ws.close();
    }));
});

describe("Architect → plan → workers (real nodes, scripted model)", () => {
  it("plans with read-only tools, fixes a rejected plan, and the approved tasks run in dependency order", () => {
    const model = new ScriptedModel((req) => {
      // The Architect's conversation: explore, submit a cyclic plan, then fix it.
      const n = req.messages.length;
      if (n === 1) return reply([toolUse("a1", "list_files", {}), toolUse("a2", "write_file", { path: "x.md", content: "no" })]);
      if (n === 3) {
        const r = lastToolResults(req);
        assert.match(r.a1.content, /README\.md/);
        assert.match(r.a2.content, /not available to the architect role/);
        return reply([
          toolUse("a3", "submit_plan", {
            summary: "v1",
            tasks: [planned("feature", { dependsOn: ["tests"] }), planned("tests", { role: "qa", dependsOn: ["feature"] })],
          }),
        ]);
      }
      assert.match(lastToolResults(req).a3.content, /plan rejected, fix it and submit again: dependency cycle/);
      return reply([
        toolUse("a4", "submit_plan", {
          summary: "Feature first, then its tests",
          tasks: [
            planned("feature", { title: "Add feature", acceptanceCriteria: ["src/feature.js exports 42"] }),
            planned("tests", { role: "qa", kind: "unit_test", title: "Test feature", dependsOn: ["feature"] }),
          ],
        }),
      ]);
    });

    // Workers use scripted executors: this test is about planning and ordering, not coding.
    const starts: string[] = [];
    const executor: TaskExecutor = {
      async implement(task, { repoDir }) {
        starts.push(task.title);
        if (task.role === "qa") {
          // The dependency is merged into the base, so the feature is already in the checkout.
          writeFiles(repoDir, { "test/feature.test.js": 'import a from "node:assert"; import { answer } from "../src/feature.js"; a.equal(answer, 42);\n' });
        } else {
          writeFiles(repoDir, { "src/feature.js": "export const answer = 42;\n" });
        }
        return { commitMessage: task.title, summary: `did ${task.title}` };
      },
    };

    return withHub(
      async (ctx) => {
        const dirs = [tempDir("aso-arch-"), tempDir("aso-dev-"), tempDir("aso-qa-")];
        const architect = startArchitect({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "arch", workDir: dirs[0] });
        const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", roles: ["backend"], workDir: dirs[1], hardware: hardware(), executor });
        const qa = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "qa", roles: ["qa"], workDir: dirs[2], hardware: hardware(), executor });
        try {
          const planId = (await api(ctx, "/api/plans", { method: "POST", body: JSON.stringify({ requirement: "Add the answer" }) })).body.planId;
          const plan = await waitFor(() => ["proposed", "failed"].includes(ctx.hub.plans.get(planId)!.state) && ctx.hub.plans.get(planId)!, 15_000);
          assert.equal(plan.state, "proposed", plan.history.map((h) => h.event).join("\n"));
          assert.equal(plan.summary, "Feature first, then its tests");
          assert.equal(plan.llm.calls, 3);
          assert.deepEqual(plan.agentLog.map((t) => t.actions.join(", ")), ["list_files, write_file x.md", "submit_plan", "submit_plan"]);
          assert.match(model.requests[0].system, /You are the Architect/);
          assert.deepEqual(model.requests[0].tools.map((t) => t.name), ["list_files", "read_file", "search", "submit_plan"]);

          const ids = (await api(ctx, `/api/plans/${planId}/approve`, { method: "POST" })).body.taskIds;
          await waitFor(() => ctx.hub.tasks.get(ids.tests)?.state === "merged", 20_000, "both tasks merged");
          assert.equal(ctx.hub.tasks.get(ids.feature)!.state, "merged");
          assert.deepEqual(starts, ["Add feature", "Test feature"]);
          assert.match(git(ctx.repoDir, "show", "main:test/feature.test.js"), /answer, 42/);
          assert.equal(git(ctx.repoDir, "status", "--porcelain"), "", "Architect never writes to the Hub repo");
        } finally {
          architect.stop();
          dev.stop();
          qa.stop();
          await Promise.all([architect.idle(), dev.runner.idle(), qa.runner.idle()]);
          for (const d of dirs) rmSync(d, { recursive: true, force: true });
        }
      },
      {
        files: { "package.json": JSON.stringify({ name: "t", type: "module", scripts: { test: "node --test" } }) },
        qa: { command: ["node", "--test"] },
        llm: { adapter: model },
      },
    );
  });
});
