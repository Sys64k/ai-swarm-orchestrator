import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { startHub, type HubHandle } from "@aso/hub";
import { createMessage } from "@aso/shared";
import { startWorker, type CommandRunner } from "@aso/worker";
import { hardware, makeTargetRepo, postTask, pushTaskBranch, tempDir, TOKEN, waitFor, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

describe("a job that finishes while the Hub restarts", () => {
  it("is claimed on reconnect, so its result counts and nothing runs twice", async () => {
    const repoDir = makeTargetRepo();
    let hub: HubHandle = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", token: TOKEN });
    const port = hub.port;
    const options = { targetDir: repoDir, port, host: "127.0.0.1", token: TOKEN };

    // QA's test command runs until the test lets it finish.
    let finishTests!: () => void;
    let testRuns = 0;
    const commands: CommandRunner = {
      kind: "host",
      run: () => {
        testRuns++;
        return new Promise((resolve) => (finishTests = () => resolve({ exitCode: 0, signal: null, timedOut: false, output: "1 passed", durationMs: 5 })));
      },
    };
    // A stand-in implementer takes the task; QA then goes to the real worker, started after it.
    const dev = await worker(port, "dev");
    await postTask(port, { taskId: "greet", role: "backend", title: "Greet", description: "Say hello" });
    const assignment = await dev.next();
    assert.equal(assignment.type, "TASK_ASSIGNMENT");
    const qa = await startWorker({ hub: `127.0.0.1:${port}`, token: TOKEN, nodeId: "qa", workDir: tempDir(), hardware: hardware(), sandbox: commands });
    try {
      await waitFor(() => hub.registry.has("qa"));
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet" }));
      const commit = await pushTaskBranch(`http://127.0.0.1:${port}/git/project.git`, "greet", { "hello.txt": "hi\n" });
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit }));
      await waitFor(() => testRuns === 1, 10_000, "QA started");
      dev.ws.close();

      // The Hub goes away mid-test, and the tests finish while it is gone.
      await hub.close();
      finishTests();
      await new Promise((r) => setTimeout(r, 300));

      hub = await startHub(options);
      const merged = await waitFor(() => hub.tasks.get("greet")?.state === "merged" && hub.tasks.get("greet"), 20_000, "merged");
      const events = merged.history.map((h) => h.event);
      assert.ok(events.some((e) => e === "qa reconnected and resumed"), events.join("\n"));
      assert.ok(!events.some((e) => e.startsWith("requeued")), "not requeued");
      assert.equal(testRuns, 1, "QA ran once");
    } finally {
      qa.stop();
      await hub.close();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
