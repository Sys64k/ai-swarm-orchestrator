import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeActions } from "@aso/hub";
import { startWorker } from "@aso/worker";
import { createMessage } from "@aso/shared";
import { hardware, postTask, pushTaskBranch, tempDir, TOKEN, waitFor, withHub, worker, type HubContext, type TestClient } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

type Json = Record<string, unknown>;
const call = (port: number, route: string, method = "POST") =>
  fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => ({
    status: r.status,
    body: (await r.json().catch(() => ({}))) as Json,
  }));

const task = (taskId: string) => ({ taskId, role: "backend", title: "Greet", description: "Say hello" });

/** `w` takes `taskId`, reports it started, and is busy with it. */
async function busyWith(ctx: HubContext, w: TestClient, nodeId: string, taskId: string) {
  await postTask(ctx.port, task(taskId));
  const assignment = await w.next();
  assert.ok(assignment.type === "TASK_ASSIGNMENT" && assignment.payload.taskId === taskId);
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "in_progress", taskId }));
  await waitFor(() => ctx.hub.tasks.get(taskId)?.state === "in_progress");
}

async function finish(ctx: HubContext, w: TestClient, nodeId: string, taskId: string) {
  const commit = await pushTaskBranch(ctx.gitUrl, taskId, { "hello.txt": "hello\n" });
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "completed", taskId, commit }));
}

describe("nodeActions", () => {
  const registration = (supervisor?: "systemd") => ({ nodeKind: "worker" as const, version: "1", hardware: undefined as never, supervisor });
  const allowed = (n: Parameters<typeof nodeActions>[0]) => {
    const a = nodeActions(n);
    return [a.drain, a.resume, a.restart];
  };

  it("allows drain, resume and restart by state", () => {
    const svc = registration("systemd");
    assert.deepEqual(allowed({ registration: svc }), [true, false, true]);
    assert.deepEqual(allowed({ registration: svc, draining: true }), [false, true, true]);
    assert.deepEqual(allowed({ registration: svc, draining: true, restart: "pending" }), [false, true, false], "resume cancels it");
    assert.deepEqual(allowed({ registration: svc, draining: true, restart: "sent" }), [false, false, false]);
    assert.match(nodeActions({ registration: svc, draining: true, restart: "sent" }).why.resume!, /already restarting/);
  });

  it("never restarts a hand-started worker, and offers nothing for the Architect", () => {
    const manual = nodeActions({ registration: registration() });
    assert.deepEqual([manual.drain, manual.restart], [true, false]);
    assert.match(manual.why.restart!, /aso service install/);
    assert.deepEqual(allowed({ registration: { nodeKind: "architect", version: "1" } }), [false, false, false]);
  });
});

describe("draining and restarting workers from the console", () => {
  it("drains a worker so it gets no new jobs, and resumes it", () =>
    withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev");
      const drained = await call(ctx.port, "/api/nodes/dev/drain");
      assert.equal(drained.status, 200);
      assert.equal(drained.body.draining, true);
      assert.deepEqual(drained.body.actions, { drain: false, resume: true, restart: false, why: { restart: (drained.body.actions as { why: { restart: string } }).why.restart } });
      assert.equal((await call(ctx.port, "/api/nodes/dev/drain")).status, 409, "already drained");

      await postTask(ctx.port, task("greet"));
      assert.ok(await w.quiet(300), "a drained worker gets no assignment");
      assert.match(ctx.hub.tasks.get("greet")?.waitingReason ?? "", /dev: draining/);

      const resumed = await call(ctx.port, "/api/nodes/dev/resume");
      assert.equal(resumed.body.draining, false);
      assert.equal((await w.next()).type, "TASK_ASSIGNMENT", "resuming hands it the waiting task");
      w.ws.close();
    }));

  it("restarts an idle service worker at once", () =>
    withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev", { supervisor: "systemd" });
      const r = await call(ctx.port, "/api/nodes/dev/restart");
      assert.equal(r.status, 200);
      assert.equal(r.body.restart, "sent");
      const control = await w.next();
      assert.ok(control.type === "NODE_CONTROL" && control.payload.action === "restart");

      const resume = await call(ctx.port, "/api/nodes/dev/resume");
      assert.equal(resume.status, 409, "too late to cancel");
      assert.match(String(resume.body.error), /already restarting/);
      assert.equal((await call(ctx.port, "/api/nodes/dev/restart")).status, 409, "asking again sends nothing new");
      assert.ok(await w.quiet());
      w.ws.close();
    }));

  it("lets a busy worker finish its job before restarting, and gives it no new work", () =>
    withHub(
      async (ctx) => {
        const w = await worker(ctx.port, "dev", { supervisor: "systemd" });
        await busyWith(ctx, w, "dev", "greet");
        const r = await call(ctx.port, "/api/nodes/dev/restart");
        assert.deepEqual([r.body.restart, r.body.draining], ["pending", true]);
        assert.ok(await w.quiet(), "no restart while the job runs");

        await finish(ctx, w, "dev", "greet");
        const control = await w.next();
        assert.equal(control.type, "NODE_CONTROL", "restart follows the job, with no QA run handed to it first");
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "awaiting_qa");
        w.ws.close();
      },
    ));

  it("cancels a pending restart on resume", () =>
    withHub(
      async (ctx) => {
        const w = await worker(ctx.port, "dev", { supervisor: "systemd" });
        await busyWith(ctx, w, "dev", "greet");
        await call(ctx.port, "/api/nodes/dev/restart");
        const resumed = await call(ctx.port, "/api/nodes/dev/resume");
        assert.deepEqual([resumed.status, resumed.body.restart, resumed.body.draining], [200, null, false]);
        await finish(ctx, w, "dev", "greet");
        assert.equal((await w.next()).type, "TEST_EXECUTION", "back to normal work, no restart");
        w.ws.close();
      },
    ));

  it("refuses to restart a hand-started worker, and unknown or non-worker nodes", () =>
    withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev");
      const manual = await call(ctx.port, "/api/nodes/dev/restart");
      assert.equal(manual.status, 409);
      assert.match(String(manual.body.error), /aso service install/);
      assert.equal(ctx.hub.registry.get("dev")?.draining, undefined, "a refused restart does not drain");

      for (const action of ["drain", "resume", "restart"]) {
        assert.equal((await call(ctx.port, `/api/nodes/ghost/${action}`)).status, 404, action);
      }
      assert.equal((await call(ctx.port, "/api/nodes/dev/restart", "GET")).status, 404, "actions are POST only");
      w.ws.close();
    }));

  it("a real worker calls its restart hook, and ignores the request without one", () =>
    withHub(async (ctx) => {
      let restarts = 0;
      const common = { hub: `127.0.0.1:${ctx.port}`, token: TOKEN, hardware: hardware(), sandbox: "none" as const };
      const service = await startWorker({ ...common, nodeId: "svc", workDir: tempDir(), supervisor: "systemd", onRestart: () => restarts++ });
      const manual = await startWorker({ ...common, nodeId: "manual", workDir: tempDir() });
      try {
        await waitFor(() => ctx.hub.registry.has("svc") && ctx.hub.registry.has("manual"));
        assert.equal((await call(ctx.port, "/api/nodes/svc/restart")).status, 200);
        await waitFor(() => restarts === 1, 5000, "restart hook");
        ctx.hub.registry.send("svc", "NODE_CONTROL", { action: "restart" }); // a repeat joins the one in progress
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(restarts, 1);
        // The Hub refuses this; a NODE_CONTROL sent anyway must not stop a worker that cannot come back.
        assert.equal((await call(ctx.port, "/api/nodes/manual/restart")).status, 409);
        ctx.hub.registry.send("manual", "NODE_CONTROL", { action: "restart" });
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(ctx.hub.registry.has("manual"));
      } finally {
        service.stop();
        manual.stop();
      }
    }));
});
