import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addOutcome, describeRecord, WorkerKeys } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import { postTask, pushTaskBranch, reply, ScriptedModel, tempDir, text, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

describe("a machine's track record", () => {
  it("counts outcomes and says them plainly", () => {
    let r = addOutcome(undefined, "built");
    for (const o of ["built", "qaPassed", "qaFailed", "qaPassed", "accepted", "tested"] as const) r = addOutcome(r, o);
    assert.deepEqual(r, { built: 2, qaPassed: 2, qaFailed: 1, accepted: 1, tested: 1 });
    assert.equal(describeRecord(r), "2 builds · QA passed 2 of 3 · acceptance met 1 of 1 · 1 QA run");
    assert.equal(describeRecord({ built: 1, failed: 1, dropped: 2 }), "1 build · 1 failed · 2 dropped");
    assert.equal(describeRecord(undefined), "no jobs yet");
  });

  it("keeps a key's record across restarts", async () => {
    const dir = tempDir();
    const keys = await WorkerKeys.open(dir);
    const { code } = keys.createJoinCode();
    const { id } = (await keys.join(code, "friend-pc"))!;
    keys.recordOutcome(id, "built");
    keys.recordOutcome(id, "qaFailed");
    await keys.flush();
    assert.deepEqual((await WorkerKeys.open(dir)).list()[0].track, { built: 1, qaFailed: 1 });
    assert.deepEqual((await WorkerKeys.open()).list(), [], "nothing for a key that doesn't exist");
    keys.recordOutcome("nope", "built"); // ignored
  });
});

const call = (port: number, route: string, body?: unknown, auth: string | null = TOKEN) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));

async function joinAs(port: number, machine: string) {
  const code = (await call(port, "/api/worker-keys/join-codes", { name: machine })).body.code as string;
  return (await call(port, "/api/worker-keys/join", { code, machine }, null)).body as { id: string; key: string };
}

function payloadOf<T extends AgentMessage["type"]>(m: AgentMessage, type: T): Extract<AgentMessage, { type: T }>["payload"] {
  assert.equal(m.type, type);
  return (m as Extract<AgentMessage, { type: T }>).payload;
}

describe("track records (Hub)", () => {
  it("credits the builder with its build and QA's verdict, and the tester with its QA run", async () => {
    await withHub(async (ctx) => {
      const builderKey = await joinAs(ctx.port, "builder");
      const testerKey = await joinAs(ctx.port, "tester");
      const builder = await worker(ctx.port, "builder", { token: builderKey.key });
      await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
      payloadOf(await builder.next(), "TASK_ASSIGNMENT");
      const tester = await worker(ctx.port, "tester", { token: testerKey.key, hostname: "tester" });

      builder.send(createMessage("STATUS_UPDATE", "builder", { state: "in_progress", taskId: "greet" }));
      const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greet.txt": "hi" });
      builder.send(createMessage("STATUS_UPDATE", "builder", { state: "completed", taskId: "greet", commit }));
      payloadOf(await tester.next(), "TEST_EXECUTION");
      tester.send(createMessage("FEEDBACK_LOOP", "tester", { taskId: "greet", commit, outcome: "pass", summary: "ok" }));
      await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged");

      const keys = (await call(ctx.port, "/api/worker-keys")).body as Array<{ id: string; track: Record<string, number> }>;
      assert.deepEqual(keys.find((k) => k.id === builderKey.id)!.track, { built: 1, qaPassed: 1 });
      assert.deepEqual(keys.find((k) => k.id === testerKey.id)!.track, { tested: 1 });
      builder.ws.close();
      tester.ws.close();
    });
  });

  it("counts neither a push that doesn't check out, nor a job lost before it started", async () => {
    await withHub(async (ctx) => {
      const flakyKey = await joinAs(ctx.port, "flaky");
      const flaky = await worker(ctx.port, "flaky", { token: flakyKey.key });
      await postTask(ctx.port, { taskId: "t1", role: "backend", title: "T", description: "d" });
      payloadOf(await flaky.next(), "TASK_ASSIGNMENT");
      flaky.send(createMessage("STATUS_UPDATE", "flaky", { state: "in_progress", taskId: "t1" }));
      await waitFor(() => ctx.hub.tasks.get("t1")?.state === "in_progress");
      flaky.send(createMessage("STATUS_UPDATE", "flaky", { state: "completed", taskId: "t1", commit: "c".repeat(40) }));
      await waitFor(() => ctx.hub.tasks.get("t1")?.reworkRound === 1, 10_000, "a rework round for the bad push");

      // The rework is assigned again; the machine drops off before starting it.
      payloadOf(await flaky.next(), "TASK_ASSIGNMENT");
      flaky.ws.close();
      await waitFor(() => ctx.hub.tasks.get("t1")?.history.some((h) => /disconnected before starting/.test(h.event)));

      const keys = (await call(ctx.port, "/api/worker-keys")).body as Array<{ id: string; track: Record<string, number> }>;
      assert.deepEqual(keys.find((k) => k.id === flakyKey.id)!.track, {}, "no build, no drop");
    });
  });
});

describe("job records and the track-records report (Hub)", () => {
  const llm = { adapter: new ScriptedModel(() => reply([text("Done.")], "end_turn"), "claude-haiku-5-5") };

  it("records each job with its desk, model, cost and what came of it, and reports them", async () => {
    await withHub(
      async (ctx) => {
        const builder = await worker(ctx.port, "builder", { hostname: "avalon" });
        await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
        payloadOf(await builder.next(), "TASK_ASSIGNMENT");
        const tester = await worker(ctx.port, "tester", { hostname: "canfod" });

        builder.send(createMessage("STATUS_UPDATE", "builder", { state: "in_progress", taskId: "greet", slot: 2 }));
        builder.send(createMessage("STATUS_UPDATE", "builder", { state: "in_progress", taskId: "greet", slot: 2 })); // again, as after a reconnect
        builder.send(createMessage("PROMPT_EXECUTION", "builder", { requestId: crypto.randomUUID(), taskId: "greet", conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
        assert.equal(payloadOf(await builder.next(), "PROMPT_RESULT").outcome, "ok");
        const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greet.txt": "hi" });
        builder.send(createMessage("STATUS_UPDATE", "builder", { state: "completed", taskId: "greet", commit }));
        payloadOf(await tester.next(), "TEST_EXECUTION");
        tester.send(createMessage("STATUS_UPDATE", "tester", { state: "in_progress", taskId: "greet", slot: 1 }));
        tester.send(createMessage("FEEDBACK_LOOP", "tester", { taskId: "greet", commit, outcome: "pass", summary: "ok" }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged");

        const jobs = ctx.hub.tasks.get("greet")!.jobs!;
        assert.deepEqual(
          jobs.map((j) => [j.job, j.round, j.host, j.slot, j.model, j.result, j.qa, j.calls]),
          [
            ["implement", 0, "avalon", 2, "claude-haiku-5-5", "built", "passed", 1],
            ["test", 0, "canfod", 1, undefined, "passed", undefined, 0],
          ],
          "one build despite the repeated report, and one QA run",
        );
        assert.ok(jobs.every((j) => j.endedAt));

        const byModel = (await call(ctx.port, "/api/track-records")).body;
        assert.equal(byModel.by, "model");
        assert.deepEqual(byModel.rows.map((r: { key: string; builds: { built: number; qaPassed: number }; tasks: { finished: number; firstTry: number } }) => [r.key, r.builds.built, r.builds.qaPassed, r.tasks.finished, r.tasks.firstTry]), [["claude-haiku-5-5", 1, 1, 1, 1]]);
        const byDesk = (await call(ctx.port, "/api/track-records?by=desk&project=project&role=backend")).body;
        assert.deepEqual(byDesk.rows.map((r: { key: string }) => r.key), ["avalon #2", "canfod #1"]);
        assert.equal((await call(ctx.port, "/api/track-records?by=planet")).status, 400);
        assert.equal((await call(ctx.port, "/api/track-records?since=yesterday")).status, 400);
        builder.ws.close();
        tester.ws.close();
      },
      { llm, acceptanceCheck: false },
    );
  });

  it("records which model judged a build's work in the acceptance check, what that cost, and its quality notes", async () => {
    const acceptanceCheck = {
      check: async (t: { spec: { acceptanceCriteria: string[] } }) => ({
        result: "met" as const,
        criteria: t.spec.acceptanceCriteria.map((criterion) => ({ criterion, verdict: "met" as const, reason: "r" })),
        summary: "",
        qualityNotes: [{ kind: "dead-code" as const, note: "an unused helper" }],
        model: "reviewer-model",
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.03 },
      }),
    };
    await withHub(
      async (ctx) => {
        const builder = await worker(ctx.port, "builder", { hostname: "avalon" });
        await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d", acceptanceCriteria: ["it greets"] });
        payloadOf(await builder.next(), "TASK_ASSIGNMENT");
        const tester = await worker(ctx.port, "tester", { hostname: "canfod" });
        builder.send(createMessage("STATUS_UPDATE", "builder", { state: "in_progress", taskId: "greet", slot: 1 }));
        const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greet.txt": "hi" });
        builder.send(createMessage("STATUS_UPDATE", "builder", { state: "completed", taskId: "greet", commit }));
        payloadOf(await tester.next(), "TEST_EXECUTION");
        tester.send(createMessage("FEEDBACK_LOOP", "tester", { taskId: "greet", commit, outcome: "pass", summary: "ok" }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged");
        const build = ctx.hub.tasks.get("greet")!.jobs![0];
        assert.deepEqual([build.acceptance, build.acceptanceModel, build.acceptanceCostUsd, build.qualityNotes], ["met", "reviewer-model", 0.03, 1]);
        const reviewer = (await call(ctx.port, "/api/track-records?by=model")).body.rows.find((r: { key: string }) => r.key === "reviewer-model");
        assert.deepEqual(reviewer.reviews, { checks: 1, met: 1, overturned: 0, unmet: 0, undecided: 0, costUsd: 0.03 });
        builder.ws.close();
        tester.ws.close();
      },
      { llm, acceptanceCheck },
    );
  });

  it("ends a job when its agent gives up, when the task is cancelled, and when its machine drops off", async () => {
    await withHub(
      async (ctx) => {
        const w = await worker(ctx.port, "dev", { hostname: "avalon" });
        await postTask(ctx.port, { taskId: "gives-up", role: "backend", title: "T", description: "d" });
        payloadOf(await w.next(), "TASK_ASSIGNMENT");
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "gives-up", slot: 1 }));
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "gives-up", detail: "can't" }));
        await waitFor(() => ctx.hub.tasks.get("gives-up")?.state === "failed");
        assert.deepEqual(ctx.hub.tasks.get("gives-up")!.jobs!.map((j) => j.result), ["failed"]);

        await postTask(ctx.port, { taskId: "stopped", role: "backend", title: "T", description: "d" });
        payloadOf(await w.next(), "TASK_ASSIGNMENT");
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "stopped", slot: 1 }));
        await waitFor(() => ctx.hub.tasks.get("stopped")?.jobs?.length === 1);
        assert.equal((await call(ctx.port, "/api/tasks/stopped/cancel", {})).status, 200);
        assert.deepEqual(ctx.hub.tasks.get("stopped")!.jobs!.map((j) => j.result), ["cancelled"]);

        await postTask(ctx.port, { taskId: "dropped", role: "backend", title: "T", description: "d" });
        payloadOf(await w.next(), "TASK_ASSIGNMENT");
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "dropped", slot: 1 }));
        await waitFor(() => ctx.hub.tasks.get("dropped")?.jobs?.length === 1);
        w.ws.close();
        await waitFor(() => ctx.hub.tasks.get("dropped")?.jobs?.[0].result === "dropped", 5000, "dropped once the grace period is over");
      },
      { llm, acceptanceCheck: false, reclaimGraceMs: 50 },
    );
  });
});
