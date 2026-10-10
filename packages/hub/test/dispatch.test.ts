import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessage, type AgentMessage } from "@aso/shared";
import { getTask, postTask, withHub, worker, connect } from "./helpers.ts";

const SHA = "b".repeat(40);

function assignment(m: AgentMessage) {
  assert.equal(m.type, "TASK_ASSIGNMENT");
  return m.type === "TASK_ASSIGNMENT" ? m.payload : assert.fail();
}

describe("task dispatch", () => {
  it("queues tasks until an eligible worker connects", () =>
    withHub(async (_hub, port) => {
      const { status, body } = await postTask(port, { role: "backend", title: "Add users table", description: "x" });
      assert.equal(status, 201);
      assert.match(body.spec.taskId, /^add-users-table-[0-9a-f]{6}$/);
      assert.equal(body.state, "pending");
      assert.match(body.waitingReason, /no worker nodes connected/);

      const w = await worker(port, "w1");
      const task = assignment(await w.next());
      assert.equal(task.taskId, body.spec.taskId);
      assert.equal(task.kind, "feature");

      const record = await getTask(port, task.taskId);
      assert.equal(record.state, "assigned");
      assert.equal(record.nodeId, "w1");
      assert.equal(record.attempts, 1);
      assert.ok(record.routing.reasons.length > 0);
      w.ws.close();
    }));

  it("routes by hardware: Docker builds to Docker hosts, migrations to fast disks", () =>
    withHub(async (_hub, port) => {
      const plain = await worker(port, "plain", { mbps: 3000 });
      const docker = await worker(port, "docker", { docker: true, mbps: 100 });

      await postTask(port, { taskId: "build-image", role: "devops", kind: "container_build", title: "t", description: "d" });
      assert.equal(assignment(await docker.next()).taskId, "build-image");

      await postTask(port, { taskId: "migrate", role: "backend", kind: "db_migration", title: "t", description: "d" });
      assert.equal(assignment(await plain.next()).taskId, "migrate");
      plain.ws.close();
      docker.ws.close();
    }));

  it("gives one task per node and hands out the next one on completion", () =>
    withHub(async (_hub, port) => {
      const w = await worker(port, "w1");
      await postTask(port, { taskId: "first", role: "backend", title: "t", description: "d" });
      await postTask(port, { taskId: "second", role: "backend", title: "t", description: "d" });
      assert.equal(assignment(await w.next()).taskId, "first");
      assert.ok(await w.quiet(), "busy node must not receive a second task");
      assert.match((await getTask(port, "second")).waitingReason, /w1: busy/);

      w.send(createMessage("STATUS_UPDATE", "w1", { state: "in_progress", taskId: "first" }));
      w.send(createMessage("STATUS_UPDATE", "w1", { state: "completed", taskId: "first", commit: SHA }));
      assert.equal(assignment(await w.next()).taskId, "second");

      const first = await getTask(port, "first");
      assert.equal(first.state, "completed");
      assert.equal(first.commit, SHA);
      w.ws.close();
    }));

  it("rejects status updates for tasks owned by another node", () =>
    withHub(async (_hub, port) => {
      const a = await worker(port, "a");
      await postTask(port, { taskId: "mine", role: "backend", title: "t", description: "d" });
      await a.next();
      const b = await worker(port, "b");
      b.send(createMessage("STATUS_UPDATE", "b", { state: "completed", taskId: "mine", commit: SHA }));
      const err = await b.next();
      assert.ok(err.type === "PROTOCOL_ERROR" && /not assigned to b/.test(err.payload.reason));
      assert.equal((await getTask(port, "mine")).state, "assigned");
      a.ws.close();
      b.ws.close();
    }));

  it("requeues a task when its node disconnects", () =>
    withHub(async (_hub, port) => {
      const a = await worker(port, "a");
      await postTask(port, { taskId: "survivor", role: "backend", title: "t", description: "d" });
      await a.next();
      const b = await worker(port, "b", { roles: ["backend"] });
      a.ws.close();
      const task = assignment(await b.next());
      assert.equal(task.taskId, "survivor");
      const record = await getTask(port, "survivor");
      assert.equal(record.nodeId, "b");
      assert.equal(record.attempts, 2);
      b.ws.close();
    }));

  it("fails a task after it exhausts its attempts", () =>
    withHub(async (hub, port) => {
      await postTask(port, { taskId: "cursed", role: "backend", title: "t", description: "d" });
      for (let i = 1; i <= 3; i++) {
        const w = await worker(port, `w${i}`);
        await w.next();
        w.ws.close();
        await w.closed;
      }
      await new Promise((r) => setTimeout(r, 50));
      const record = hub.tasks.get("cursed")!;
      assert.equal(record.state, "failed");
      assert.match(record.detail!, /gave up after 3 attempts/);
    }));

  it("validates task submissions", () =>
    withHub(async (_hub, port) => {
      const bad = await postTask(port, { role: "wizard", title: "t", description: "d" });
      assert.equal(bad.status, 400);
      assert.match(bad.body.error, /role/);
      const traversal = await postTask(port, { role: "backend", title: "t", description: "d", files: ["../x"] });
      assert.equal(traversal.status, 400);
      await postTask(port, { taskId: "dup", role: "backend", title: "t", description: "d" });
      assert.equal((await postTask(port, { taskId: "dup", role: "backend", title: "t", description: "d" })).status, 409);
    }));

  it("records heartbeats and drops silent nodes", () =>
    withHub(
      async (hub, port) => {
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
    withHub(async (_hub, port) => {
      const arch = await connect(port);
      arch.send(createMessage("NODE_REGISTRATION", "arch", { nodeKind: "architect", version: "t" }));
      await arch.next();
      const { body } = await postTask(port, { role: "backend", title: "t", description: "d" });
      assert.equal(body.state, "pending");
      assert.ok(await arch.quiet());
      arch.ws.close();
    }));
});
