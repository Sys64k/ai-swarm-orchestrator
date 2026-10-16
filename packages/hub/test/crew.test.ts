import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentName, createMessage } from "@aso/shared";
import { postTask, pushTaskBranch, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const nodes = async (port: number) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/nodes`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Array<{
    nodeId: string;
    jobs: Array<{ taskId: string; job: string; slot?: number }>;
  }>;

describe("which agent works on what", () => {
  it("records the machine and desk that implemented and tested a task, and seats running jobs", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { hostname: "avalon", slots: 4 });
      const qa = await worker(ctx.port, "qa", { hostname: "canfod", slots: 2 });
      await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "Say hello" });
      assert.equal((await dev.next()).type, "TASK_ASSIGNMENT");

      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 3 }));
      await waitFor(() => ctx.hub.tasks.get("greet")?.crew?.length === 1, 5000, "crew");
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 3, detail: "still at it" }));
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "waiting_llm", taskId: "greet" }));
      await waitFor(() => ctx.hub.tasks.get("greet")?.detail === "still at it");
      const seated = (await nodes(ctx.port)).find((n) => n.nodeId === "dev")!;
      assert.deepEqual(seated.jobs, [{ taskId: "greet", job: "implement", slot: 3 }]);

      const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "hello.txt": "hi\n" });
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit }));
      assert.equal((await qa.next()).type, "TEST_EXECUTION");
      qa.send(createMessage("STATUS_UPDATE", "qa", { state: "in_progress", taskId: "greet", slot: 1 }));
      await waitFor(() => ctx.hub.tasks.get("greet")?.crew?.length === 2, 5000, "tester");
      assert.deepEqual((await nodes(ctx.port)).find((n) => n.nodeId === "qa")!.jobs, [{ taskId: "greet", job: "test", slot: 1 }]);

      const task = ctx.hub.tasks.get("greet")!;
      assert.deepEqual(
        task.crew!.map((m) => [m.job, agentName(m), m.nodeId]),
        [
          ["implement", "avalon #3", "dev"],
          ["test", "canfod #1", "qa"],
        ],
        "one entry per agent, however often it reports",
      );
      assert.ok(task.history.some((h) => h.event === "started on dev (avalon #3)"));
      dev.ws.close();
      qa.ws.close();
    }));
});
