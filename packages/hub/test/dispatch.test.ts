import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessage, type AgentMessage } from "@aso/shared";
import { connect, getTask, postTask, waitFor, withHub, worker } from "./helpers.ts";

function assignment(m: AgentMessage) {
  assert.equal(m.type, "TASK_ASSIGNMENT");
  return m.type === "TASK_ASSIGNMENT" ? m.payload : assert.fail();
}

const task = (taskId: string, extra: Record<string, unknown> = {}) => ({
  taskId,
  role: "backend",
  title: "t",
  description: "d",
  ...extra,
});

describe("task dispatch", () => {
  it("queues tasks until an eligible worker connects", () =>
    withHub(async ({ port }) => {
      const { status, body } = await postTask(port, { role: "backend", title: "Add users table", description: "x" });
      assert.equal(status, 201);
      assert.match(body.spec.taskId, /^add-users-table-[0-9a-f]{6}$/);
      assert.equal(body.state, "pending");
      assert.match(body.waitingReason, /no worker nodes connected/);

      const w = await worker(port, "w1");
      const t = assignment(await w.next());
      assert.equal(t.taskId, body.spec.taskId);
      assert.equal(t.kind, "feature");
      assert.equal(t.rework, undefined);

      const record = await getTask(port, t.taskId);
      assert.equal(record.state, "assigned");
      assert.equal(record.nodeId, "w1");
      assert.equal(record.attempts, 1);
      assert.ok(record.routing.reasons.length > 0);
      w.ws.close();
    }));

  it("routes by hardware: Docker builds to Docker hosts, migrations to fast disks", () =>
    withHub(async ({ port }) => {
      const plain = await worker(port, "plain", { mbps: 3000 });
      const docker = await worker(port, "docker", { docker: true, mbps: 100 });

      await postTask(port, task("build-image", { role: "devops", kind: "container_build" }));
      assert.equal(assignment(await docker.next()).taskId, "build-image");

      await postTask(port, task("migrate", { kind: "db_migration" }));
      assert.equal(assignment(await plain.next()).taskId, "migrate");
      plain.ws.close();
      docker.ws.close();
    }));

  it("gives one task per node and hands out the next one when it finishes", () =>
    withHub(async ({ port }) => {
      const w = await worker(port, "w1");
      await postTask(port, task("first"));
      await postTask(port, task("second"));
      assert.equal(assignment(await w.next()).taskId, "first");
      assert.ok(await w.quiet(), "busy node must not receive a second task");
      assert.match((await getTask(port, "second")).waitingReason, /w1: busy/);

      w.send(createMessage("STATUS_UPDATE", "w1", { state: "in_progress", taskId: "first" }));
      w.send(createMessage("STATUS_UPDATE", "w1", { state: "failed", taskId: "first", detail: "boom" }));
      assert.equal(assignment(await w.next()).taskId, "second");
      assert.equal((await getTask(port, "first")).state, "failed");
      w.ws.close();
    }));

  it("rejects status updates for tasks owned by another node", () =>
    withHub(async ({ port }) => {
      const a = await worker(port, "a");
      await postTask(port, task("mine"));
      await a.next();
      const b = await worker(port, "b");
      b.send(createMessage("STATUS_UPDATE", "b", { state: "failed", taskId: "mine" }));
      const err = await b.next();
      assert.ok(err.type === "PROTOCOL_ERROR" && /not assigned to b/.test(err.payload.reason));
      assert.equal((await getTask(port, "mine")).state, "assigned");
      a.ws.close();
      b.ws.close();
    }));

  it("validates task submissions", () =>
    withHub(async ({ port }) => {
      const bad = await postTask(port, { role: "wizard", title: "t", description: "d" });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /role/);
      const traversal = await postTask(port, task("x", { files: ["../x"] }));
      assert.equal(traversal.status, 400);
      await postTask(port, task("dup"));
      assert.equal((await postTask(port, task("dup"))).status, 409);
    }));

  it("records heartbeats and drops silent nodes", () =>
    withHub(
      async ({ hub, port }) => {
        const w = await worker(port, "hb");
        w.send(createMessage("NODE_HEARTBEAT", "hb", { memoryAvailableBytes: 123, cpuLoadPercent: 50, dockerAvailable: true }));
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(hub.registry.get("hb")?.heartbeat?.cpuLoadPercent, 50);

        assert.equal(await w.closed, 4008);
        assert.equal(hub.registry.has("hb"), false);
      },
      { nodeTimeoutMs: 300 },
    ));

  it("keeps the architect out of worker routing", () =>
    withHub(async ({ port }) => {
      const arch = await connect(port);
      arch.send(createMessage("NODE_REGISTRATION", "arch", { nodeKind: "architect", version: "t" }));
      await arch.next();
      const { body } = await postTask(port, task("t1"));
      assert.equal(body.state, "pending");
      assert.ok(await arch.quiet());
      arch.ws.close();
    }));
});

describe("node loss", () => {
  it("reassigns immediately when the node had not started the task", () =>
    withHub(async ({ port }) => {
      const a = await worker(port, "a");
      await postTask(port, task("survivor"));
      await a.next();
      a.send(createMessage("STATUS_UPDATE", "a", { state: "accepted", taskId: "survivor" }));
      const b = await worker(port, "b", { roles: ["backend"] });
      a.ws.close();

      assert.equal(assignment(await b.next()).taskId, "survivor");
      const record = await getTask(port, "survivor");
      assert.equal(record.nodeId, "b");
      assert.equal(record.attempts, 2);
      assert.equal(record.drops, 1);
      b.ws.close();
    }));

  it("holds a started task for its node and lets it resume after reconnecting", () =>
    withHub(async ({ hub, port }) => {
      const a = await worker(port, "a");
      await postTask(port, task("long-job"));
      await a.next();
      a.send(createMessage("STATUS_UPDATE", "a", { state: "in_progress", taskId: "long-job" }));
      await waitFor(() => hub.tasks.get("long-job")?.state === "in_progress");

      const b = await worker(port, "b");
      a.ws.close();
      await a.closed;
      assert.ok(await b.quiet(300), "started task must not be reassigned during the grace period");
      assert.ok(hub.tasks.get("long-job")?.detachedAt);

      const back = await worker(port, "a", { resume: { taskId: "long-job", job: "implement" } });
      const record = hub.tasks.get("long-job")!;
      assert.equal(record.detachedAt, undefined);
      assert.equal(record.nodeId, "a");
      assert.equal(record.drops, 0);
      assert.equal(hub.registry.get("a")?.currentTaskId, "long-job");

      back.send(createMessage("STATUS_UPDATE", "a", { state: "failed", taskId: "long-job", detail: "x" }));
      await waitFor(() => hub.tasks.get("long-job")?.state === "failed");
      back.ws.close();
      b.ws.close();
    }));

  it("requeues a held task when its node comes back without it", () =>
    withHub(async ({ hub, port }) => {
      const a = await worker(port, "a");
      await postTask(port, task("lost-job"));
      await a.next();
      a.send(createMessage("STATUS_UPDATE", "a", { state: "in_progress", taskId: "lost-job" }));
      await waitFor(() => hub.tasks.get("lost-job")?.state === "in_progress");
      a.ws.close();
      await a.closed;

      const restarted = await worker(port, "a"); // e.g. process restarted: no resume claim
      const t = assignment(await restarted.next());
      assert.equal(t.taskId, "lost-job");
      assert.equal(hub.tasks.get("lost-job")?.drops, 1);
      restarted.ws.close();
    }));

  it("reassigns a held task after the grace period and fences the old node", () =>
    withHub(
      async ({ hub, port }) => {
        const a = await worker(port, "a");
        await postTask(port, task("stalled"));
        await a.next();
        a.send(createMessage("STATUS_UPDATE", "a", { state: "in_progress", taskId: "stalled" }));
        await waitFor(() => hub.tasks.get("stalled")?.state === "in_progress");
        const b = await worker(port, "b");
        a.ws.close();

        assert.equal(assignment(await b.next(3000)).taskId, "stalled");
        assert.match(hub.tasks.get("stalled")!.history.at(-2)!.event, /did not return within the grace period/);

        const late = await worker(port, "a", { resume: { taskId: "stalled", job: "implement" } });
        assert.equal(hub.tasks.get("stalled")?.nodeId, "b", "late resume must not steal the task back");
        late.send(createMessage("STATUS_UPDATE", "a", { state: "failed", taskId: "stalled" }));
        const err = await late.next();
        assert.ok(err.type === "PROTOCOL_ERROR" && /not assigned to a/.test(err.payload.reason));
        late.ws.close();
        b.ws.close();
      },
      { reclaimGraceMs: 300 },
    ));

  it("fails a task after too many node losses", () =>
    withHub(async ({ hub, port }) => {
      await postTask(port, task("cursed"));
      for (let i = 1; i <= 3; i++) {
        const w = await worker(port, `w${i}`);
        await w.next();
        w.ws.close();
        await w.closed;
      }
      await waitFor(() => hub.tasks.get("cursed")?.state === "failed");
      assert.match(hub.tasks.get("cursed")!.detail!, /gave up after 3 node losses/);
    }));
});
