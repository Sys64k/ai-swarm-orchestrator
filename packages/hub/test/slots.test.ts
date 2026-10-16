import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { selectNode, type NodeSnapshot } from "@aso/hub";
import { createMessage, type HardwareProfile } from "@aso/shared";
import { defaultSlots, resolveSlots, startWorker, type TaskExecutor } from "@aso/worker";
import { git, hardware, postTask, tempDir, TOKEN, waitFor, withHub, worker, writeFiles } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const GiB = 1024 ** 3;
const task = (taskId: string) => ({ taskId, role: "backend", title: `Task ${taskId}`, description: "d" });

/** A promise with its resolver, to hold a job open. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

describe("job slots: default count", () => {
  const machine = (cores: number, ramGiB: number): Pick<HardwareProfile, "cpu" | "memory"> => ({
    cpu: { brand: "c", physicalCores: cores, logicalCores: cores },
    memory: { totalBytes: ramGiB * GiB, availableBytes: ramGiB * GiB },
  });

  it("takes one slot per 2 threads and 6 GiB, at most 4 and at least 1", () => {
    assert.equal(defaultSlots(machine(16, 32), "docker"), 4, "capped at 4");
    assert.equal(defaultSlots(machine(16, 13), "docker"), 2, "RAM-bound");
    assert.equal(defaultSlots(machine(4, 64), "docker"), 2, "CPU-bound");
    assert.equal(defaultSlots(machine(6, 11), "docker"), 1);
    assert.equal(defaultSlots(machine(1, 2), "docker"), 1, "never 0");
  });

  it("uses an asked-for count within 1..16 instead", () => {
    assert.deepEqual([3, 40, 0].map((n) => resolveSlots(n, machine(2, 2), "none")), [3, 16, 1]);
    assert.equal(resolveSlots(undefined, machine(16, 32), "docker"), 4);
  });

  it("runs one job at a time without the Docker sandbox, which would share ports", () => {
    assert.equal(defaultSlots(machine(16, 32), "none"), 1);
    assert.equal(defaultSlots(machine(16, 32), "custom"), 4);
  });
});

describe("job slots: routing", () => {
  const node = (nodeId: string, slots: number, running: number): NodeSnapshot => ({
    nodeId,
    hardware: {
      hostname: nodeId,
      platform: "linux",
      distro: "x",
      cpu: { brand: "c", physicalCores: 8, logicalCores: 8 },
      memory: { totalBytes: 16 * GiB, availableBytes: 16 * GiB },
      disks: [],
      docker: { available: true },
      storage: { workDir: "/w", writeMBps: 500 },
    },
    slots,
    freeSlots: slots - running,
  });

  it("prefers the node with more free slots, and skips full ones", () => {
    const d = selectNode({ role: "backend", kind: "feature" }, [node("half", 4, 2), node("fresh", 4, 1), node("full", 2, 2)]);
    assert.ok(d.ok);
    assert.equal(d.nodeId, "fresh");
    assert.ok(d.reasons.includes("3 of 4 job slots free"));
    assert.deepEqual(d.ranking.map((r) => [r.nodeId, r.score]), [["fresh", 0.75], ["half", 0.5]]);
  });

  it("keeps using a node with a free slot rather than waiting", () => {
    const d = selectNode({ role: "backend", kind: "feature" }, [node("big", 4, 3)]);
    assert.ok(d.ok && d.nodeId === "big");
  });
});

describe("job slots: Hub", () => {
  it("gives a worker as many jobs as it has slots, and the next when one frees up", () =>
    withHub(async ({ hub, port }) => {
      const w = await worker(port, "big", { slots: 2 });
      for (const id of ["a", "b", "c"]) await postTask(port, task(id));
      const first = [await w.next(), await w.next()].map((m) => (m.type === "TASK_ASSIGNMENT" ? m.payload.taskId : m.type));
      assert.deepEqual(first.sort(), ["a", "b"]);
      assert.ok(await w.quiet(200), "no third job while both slots are taken");
      assert.match(hub.tasks.get("c")?.waitingReason ?? "", /big: busy/);
      assert.ok(hub.registry.isFull("big"));
      const view = hub.registry.view(hub.registry.get("big")!);
      assert.deepEqual([view.slots, [...view.currentTaskIds].sort(), view.currentTaskId], [2, ["a", "b"], "a"]);
      assert.equal("running" in view, false, "registration-time jobs are not shown as live");

      w.send(createMessage("STATUS_UPDATE", "big", { state: "failed", taskId: "a", detail: "x" }));
      const next = await w.next();
      assert.ok(next.type === "TASK_ASSIGNMENT" && next.payload.taskId === "c");
      w.ws.close();
    }));

  it("hands back every job a reconnecting worker still runs, and requeues the others", () =>
    withHub(
      async ({ hub, port }) => {
        const w = await worker(port, "big", { slots: 3 });
        for (const id of ["a", "b", "c"]) await postTask(port, task(id));
        for (let i = 0; i < 3; i++) await w.next();
        for (const id of ["a", "b", "c"]) w.send(createMessage("STATUS_UPDATE", "big", { state: "in_progress", taskId: id }));
        await waitFor(() => ["a", "b", "c"].every((id) => hub.tasks.get(id)?.state === "in_progress"));
        w.ws.close();
        await w.closed;
        await waitFor(() => hub.tasks.get("a")?.detachedAt !== undefined);

        const back = await worker(port, "big", { slots: 3, running: [{ taskId: "a", job: "implement" }, { taskId: "b", job: "implement" }] });
        assert.deepEqual([hub.tasks.get("a")?.detachedAt, hub.tasks.get("b")?.detachedAt, hub.tasks.get("a")?.drops], [undefined, undefined, 0], "a and b resumed");
        assert.equal(hub.tasks.get("c")?.drops, 1, "c was lost");
        const again = await back.next();
        assert.ok(again.type === "TASK_ASSIGNMENT" && again.payload.taskId === "c", "and goes to the free slot");
        assert.deepEqual([...hub.registry.get("big")!.jobs].sort(), ["a", "b", "c"]);
        back.ws.close();
      },
      { reclaimGraceMs: 10_000 },
    ));

  it("restarts a service worker only once all its jobs are done", () =>
    withHub(async ({ hub, port }) => {
      const w = await worker(port, "big", { slots: 2, supervisor: "systemd" });
      for (const id of ["a", "b"]) await postTask(port, task(id));
      await w.next();
      await w.next();
      hub.registry.requestRestart("big");
      w.send(createMessage("STATUS_UPDATE", "big", { state: "failed", taskId: "a", detail: "x" }));
      assert.ok(await w.quiet(200), "b still runs");
      w.send(createMessage("STATUS_UPDATE", "big", { state: "failed", taskId: "b", detail: "x" }));
      assert.equal((await w.next()).type, "NODE_CONTROL");
      w.ws.close();
    }));
});

describe("job slots: real worker", () => {
  it("runs two tasks at once in separate checkouts, then the third in a freed one", () =>
    withHub(
      async (ctx) => {
        const gates = new Map(["a", "b", "c"].map((id) => [id, gate()]));
        const started: Array<{ taskId: string; repoDir: string }> = [];
        const executor: TaskExecutor = {
          async implement(t, { repoDir }) {
            started.push({ taskId: t.taskId, repoDir });
            writeFiles(repoDir, { [`${t.taskId}.txt`]: `${t.taskId}\n` });
            await gates.get(t.taskId)!.opened;
            return { commitMessage: `feat: ${t.taskId}` };
          },
        };
        const workDir = tempDir("aso-slots-");
        const w = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "big", workDir, hardware: hardware(), sandbox: "none", slots: 2, executor });
        try {
          await waitFor(() => ctx.hub.registry.has("big"));
          for (const id of ["a", "b", "c"]) await postTask(ctx.port, task(id));
          await waitFor(() => started.length === 2, 10_000, "two jobs to start");
          assert.deepEqual(started.map((s) => path.basename(s.repoDir)).sort(), ["project", "project.2"]);
          assert.equal(w.runner.running.length, 2);
          assert.equal(ctx.hub.tasks.get("c")?.state, "pending");

          const firstSlot = started.find((s) => s.taskId === "a")!.repoDir;
          gates.get("a")!.open();
          await waitFor(() => started.length === 3, 10_000, "third job to start");
          assert.equal(started[2].repoDir, firstSlot, "c reuses the checkout a finished in");

          gates.get("b")!.open();
          gates.get("c")!.open();
          await waitFor(() => ["a", "b", "c"].every((id) => ctx.hub.tasks.get(id)?.state === "merged"), 20_000, "all merged");
          for (const id of ["a", "b", "c"]) assert.equal(git(ctx.repoDir, "show", `main:${id}.txt`), id);
        } finally {
          for (const g of gates.values()) g.open();
          w.stop();
          await w.runner.idle();
        }
      },
      { qa: { enabled: false } },
    ));
});
