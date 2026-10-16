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

describe("automatic worker updates", () => {
  const HUB = "0.1.0+new";
  /** The Hub serves build HUB (the package file is never read here). */
  const dist = { version: () => HUB, tarball: () => "/nonexistent/aso.tgz" };
  const updatable = { supervisor: "systemd" as const, updates: "package" as const, version: "0.1.0+old" };
  /** `id` reconnects as an updatable worker while still running "greet" (as after a Hub restart). */
  const reconnectBusy = async (ctx: HubContext, id: string, hostname: string) => {
    const first = await worker(ctx.port, id, { hostname });
    await busyWith(ctx, first, id, "greet");
    first.ws.close();
    await first.closed;
    await waitFor(() => ctx.hub.tasks.get("greet")?.detachedAt !== undefined, 5000, "detached");
    // Two slots, so only the update (not a full worker) keeps new jobs away.
    return worker(ctx.port, id, { ...updatable, hostname, slots: 2, running: [{ taskId: "greet", job: "implement" }] });
  };
  const view = async (ctx: HubContext, id: string) => ((await call(ctx.port, "/api/nodes", "GET")).body as unknown as Json[]).find((n) => n.nodeId === id)!;

  it("updates an idle outdated worker at once, and a busy one after its job, giving it no new work", () =>
    withHub(
      async (ctx) => {
        const idle = await worker(ctx.port, "idle", { ...updatable, hostname: "a" });
        const control = await idle.next();
        assert.ok(control.type === "NODE_CONTROL" && control.payload.action === "update" && control.payload.version === HUB);
        const v = await view(ctx, "idle");
        assert.deepEqual([v.restart, v.updateTo, v.draining, v.updateError], ["sent", HUB, true, null]);
        idle.ws.close();

        // A worker that reconnects with a job still running finishes it first.
        const busy = await reconnectBusy(ctx, "busy", "b");
        assert.equal((await view(ctx, "busy")).restart, "pending");
        await postTask(ctx.port, task("other"));
        assert.ok(await busy.quiet(300), "no update and no new job while the job runs");
        await finish(ctx, busy, "busy", "greet");
        const later = await busy.next();
        assert.ok(later.type === "NODE_CONTROL" && later.payload.action === "update");
        busy.ws.close();
      },
      { dist, reclaimGraceMs: 10_000 },
    ));

  it("leaves current, hand-started and source-checkout workers alone", () =>
    withHub(
      async (ctx) => {
        const current = await worker(ctx.port, "current", { ...updatable, version: HUB, hostname: "a" });
        const manual = await worker(ctx.port, "manual", { updates: "package", version: "0.1.0+old", hostname: "b" });
        const source = await worker(ctx.port, "source", { supervisor: "systemd", version: "0.1.0+old", hostname: "c" });
        for (const w of [current, manual, source]) assert.ok(await w.quiet(), "no NODE_CONTROL");
        await postTask(ctx.port, task("greet"));
        await waitFor(() => ctx.hub.tasks.get("greet")?.nodeId, 5000, "an outdated worker still gets jobs");
        const v = await view(ctx, "source");
        assert.deepEqual([v.restart, v.updateTo, v.draining], [null, null, false]);
        assert.match(ctx.hub.registry.requestUpdate("source", HUB)!, /^it cannot update itself: .*predates automatic updates$/);
        for (const w of [current, manual, source]) w.ws.close();
      },
      { dist },
    ));

  it("does nothing with automatic updates off, or when the Hub serves no package", async () => {
    for (const opts of [{ dist, autoUpdate: false }, {}]) {
      await withHub(async (ctx) => {
        const w = await worker(ctx.port, "dev", updatable);
        assert.ok(await w.quiet());
        assert.equal((await view(ctx, "dev")).restart, null);
        w.ws.close();
      }, opts);
    }
  });

  it("gives a worker work again when its update fails, and does not ask that machine again for the build", () =>
    withHub(
      async (ctx) => {
        const w = await worker(ctx.port, "dev", { ...updatable, hostname: "avalon" });
        assert.equal((await w.next()).type, "NODE_CONTROL");
        w.send(createMessage("UPDATE_FAILED", "dev", { version: HUB, reason: "npm install exited with code 1" }));
        await waitFor(async () => (await view(ctx, "dev")).updateError !== null, 5000, "failure recorded");
        const v = await view(ctx, "dev");
        assert.deepEqual([v.restart, v.updateTo, v.draining], [null, null, false]);
        assert.deepEqual(v.updateError, { version: HUB, reason: "npm install exited with code 1" });
        await postTask(ctx.port, task("greet"));
        assert.equal((await w.next()).type, "TASK_ASSIGNMENT", "back to work");
        w.ws.close();
        await waitFor(() => !ctx.hub.registry.has("dev"));

        const again = await worker(ctx.port, "dev2", { ...updatable, hostname: "avalon" });
        assert.equal((await again.next()).type, "TASK_ASSIGNMENT", "same machine, same build: not asked again, given work");
        assert.match(String(((await view(ctx, "dev2")).updateError as Json).reason), /npm install/);
        again.ws.close();
      },
      { dist },
    ));

  it("stops after a machine keeps coming back on its old build, and forgets once it is current", () =>
    withHub(
      async (ctx) => {
        for (let i = 1; i <= 2; i++) {
          const w = await worker(ctx.port, `try${i}`, { ...updatable, hostname: "avalon" });
          assert.equal((await w.next()).type, "NODE_CONTROL", `attempt ${i}`);
          w.ws.close();
          await waitFor(() => !ctx.hub.registry.has(`try${i}`));
        }
        const stuck = await worker(ctx.port, "try3", { ...updatable, hostname: "avalon" });
        assert.ok(await stuck.quiet(), "no third attempt");
        assert.match(String(((await view(ctx, "try3")).updateError as Json).reason), /came back on 0\.1\.0\+old after 2 updates/);
        stuck.ws.close();
        await waitFor(() => !ctx.hub.registry.has("try3"));

        // Updated by hand: the record goes, so a later build is tried again.
        const current = await worker(ctx.port, "now", { ...updatable, version: HUB, hostname: "avalon" });
        assert.equal((await view(ctx, "now")).updateError, null);
        current.ws.close();
      },
      { dist },
    ));

  it("cancels a pending update on resume", () =>
    withHub(
      async (ctx) => {
        const w = await reconnectBusy(ctx, "dev", "a");
        const resumed = await call(ctx.port, "/api/nodes/dev/resume");
        assert.deepEqual([resumed.status, resumed.body.restart, resumed.body.updateTo], [200, null, null]);
        await finish(ctx, w, "dev", "greet");
        assert.equal((await w.next()).type, "TEST_EXECUTION", "no update after the job");
        w.ws.close();
      },
      { dist, reclaimGraceMs: 10_000 },
    ));

  it("a real worker runs its update hook once idle, and reports a failed install", () =>
    withHub(
      async (ctx) => {
        const calls: Array<string | undefined> = [];
        let fail = true;
        const w = await startWorker({
          hub: `127.0.0.1:${ctx.port}`,
          token: TOKEN,
          nodeId: "svc",
          workDir: tempDir(),
          hardware: hardware(),
          sandbox: "none",
          version: "0.1.0+old",
          supervisor: "systemd",
          onUpdate: async (version) => {
            calls.push(version);
            if (fail) throw new Error("npm install exited with code 1");
          },
        });
        try {
          await waitFor(async () => ((await view(ctx, "svc"))?.updateError as Json | null)?.reason === "npm install exited with code 1", 5000, "failure reported");
          assert.deepEqual(calls, [HUB]);
          assert.equal((await view(ctx, "svc")).updates, "package");
          // A later request is not swallowed by the failed one.
          fail = false;
          ctx.hub.registry.send("svc", "NODE_CONTROL", { action: "update", version: HUB });
          await waitFor(() => calls.length === 2, 5000, "second update");
        } finally {
          w.stop();
        }

        const manual = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "manual", workDir: tempDir(), hardware: { ...hardware(), hostname: "m" }, sandbox: "none", version: "0.1.0+old" });
        try {
          await waitFor(() => ctx.hub.registry.has("manual"));
          ctx.hub.registry.send("manual", "NODE_CONTROL", { action: "update", version: HUB }); // the Hub would not; answer it anyway
          await waitFor(async () => (await view(ctx, "manual"))?.updateError !== null, 5000, "refusal reported");
          assert.match(String(((await view(ctx, "manual")).updateError as Json).reason), /cannot update itself/);
          assert.ok(ctx.hub.registry.has("manual"), "still running");
        } finally {
          manual.stop();
        }
      },
      { dist },
    ));
});
