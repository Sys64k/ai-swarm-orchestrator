import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { startHub, Transcripts } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import {
  makeTargetRepo,
  postTask,
  pushTaskBranch,
  reply,
  ScriptedModel,
  tempDir,
  text,
  TOKEN,
  toolUse,
  waitFor,
  withHub,
  worker,
  type HubContext,
  type TestClient,
} from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const call = (port: number, route: string, method = "GET") =>
  fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as Record<string, any>,
  }));

function result(m: AgentMessage) {
  assert.equal(m.type, "PROMPT_RESULT");
  return m.type === "PROMPT_RESULT" ? m.payload : assert.fail();
}

/** A worker that took `taskId` and reported it started. */
async function implementing(ctx: HubContext, nodeId: string, taskId: string): Promise<TestClient> {
  const w = await worker(ctx.port, nodeId);
  await postTask(ctx.port, { taskId, role: "backend", title: "Greet", description: "Say hello" });
  const assignment = await w.next();
  assert.ok(assignment.type === "TASK_ASSIGNMENT" && assignment.payload.taskId === taskId);
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "in_progress", taskId }));
  await waitFor(() => ctx.hub.tasks.get(taskId)?.state === "in_progress");
  return w;
}

const prompt = (nodeId: string, taskId: string, conversationId: string, turn: number, toolResults: unknown[] = []) =>
  createMessage("PROMPT_EXECUTION", nodeId, { requestId: crypto.randomUUID(), taskId, conversationId, turn, toolResults } as never);

describe("cancel and retry", () => {
  it("cancels a queued task, blocks its dependents, and retries it", () =>
    withHub(async (ctx) => {
      await postTask(ctx.port, { taskId: "api", role: "backend", title: "API", description: "x" });
      await postTask(ctx.port, { taskId: "ui", role: "frontend", title: "UI", description: "x", dependsOn: ["api"] });

      const cancelled = await call(ctx.port, "/api/tasks/api/cancel", "POST");
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.state, "cancelled");
      ctx.hub.tasks.dispatch();
      assert.match(ctx.hub.tasks.get("ui")!.waitingReason!, /blocked: dependency api failed or was cancelled/);
      assert.equal((await call(ctx.port, "/api/tasks/api/cancel", "POST")).status, 409, "already cancelled");

      const retried = await call(ctx.port, "/api/tasks/api/retry", "POST");
      assert.equal(retried.status, 200);
      assert.equal(retried.body.state, "pending");
      assert.equal(retried.body.retries, 1);
      assert.match(retried.body.rework.reason, /Retried by a person; the previous attempt was cancelled/);

      // Retrying something that is still running or queued is refused.
      assert.equal((await call(ctx.port, "/api/tasks/api/retry", "POST")).status, 409);
      assert.equal((await call(ctx.port, "/api/tasks/nope/retry", "POST")).status, 404);
      assert.equal((await call(ctx.port, "/api/tasks/nope/cancel", "POST")).status, 404);

      const w = await worker(ctx.port, "dev");
      const assignment = await w.next();
      assert.ok(assignment.type === "TASK_ASSIGNMENT" && assignment.payload.taskId === "api");
      assert.equal(assignment.payload.rework?.round, 1, "the agent hears why it is running again");
      w.ws.close();
    }));

  it("fences the worker of a cancelled task and frees it for other work", () => {
    const model = new ScriptedModel(() => reply([toolUse("tu_1", "list_files", {})]));
    return withHub(
      async (ctx) => {
        const w = await implementing(ctx, "dev", "greet");
        await call(ctx.port, "/api/tasks/greet/cancel", "POST");

        w.send(prompt("dev", "greet", crypto.randomUUID(), 0));
        const r = result(await w.next());
        assert.ok(r.outcome === "error" && /not being implemented by dev/.test(r.error));
        assert.equal(model.requests.length, 0, "no model call for a cancelled task");

        w.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: "a".repeat(40) }));
        assert.equal((await w.next()).type, "PROTOCOL_ERROR");
        assert.equal(ctx.hub.tasks.get("greet")!.state, "cancelled");

        await postTask(ctx.port, { taskId: "next", role: "backend", title: "Next", description: "x" });
        const next = await w.next();
        assert.ok(next.type === "TASK_ASSIGNMENT" && next.payload.taskId === "next", "the node is free again");
        w.ws.close();
      },
      { llm: { adapter: model } },
    );
  });

  it("gives a retried task a fresh budget", () => {
    const model = new ScriptedModel(() => reply([toolUse("tu_1", "list_files", {})], "tool_use", 2_000_000));
    return withHub(
      async (ctx) => {
        let w = await implementing(ctx, "dev", "greet");
        w.send(prompt("dev", "greet", crypto.randomUUID(), 0));
        assert.equal(result(await w.next()).outcome, "ok");
        w.send(prompt("dev", "greet", crypto.randomUUID(), 0));
        const over = result(await w.next());
        assert.ok(over.outcome === "error" && /reached its LLM budget/.test(over.error));

        w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "greet", detail: "over budget" }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "failed");
        const spent = ctx.hub.tasks.get("greet")!.llm.costUsd;

        await call(ctx.port, "/api/tasks/greet/retry", "POST");
        const assignment = await w.next();
        assert.ok(assignment.type === "TASK_ASSIGNMENT");
        assert.match(assignment.payload.rework!.reason, /previous attempt failed: over budget/);
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet" }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "in_progress");
        w.send(prompt("dev", "greet", crypto.randomUUID(), 0));
        assert.equal(result(await w.next()).outcome, "ok", "budget counts from the retry");
        assert.ok(ctx.hub.tasks.get("greet")!.llm.costUsd > spent, "total spend keeps counting");
        w.ws.close();
      },
      { llm: { adapter: model, taskBudgetUsd: 1 } },
    );
  });
});

describe("transcripts", () => {
  it("records agent text, tool calls with their results, events and QA output", () => {
    const model = new ScriptedModel((_req, n) =>
      n === 0 ? reply([text("Let me look."), toolUse("tu_1", "run_command", { argv: ["npm", "test"] })]) : reply([text("Done.")], "end_turn"),
    );
    return withHub(
      async (ctx) => {
        const w = await implementing(ctx, "dev", "greet");
        const conv = crypto.randomUUID();
        w.send(prompt("dev", "greet", conv, 0));
        result(await w.next());
        w.send(prompt("dev", "greet", conv, 1, [{ toolUseId: "tu_1", content: "exit code 1\nFAIL greeting.test.js", isError: true }]));
        result(await w.next());

        const { body } = await call(ctx.port, "/api/tasks/greet/transcript");
        const kinds = body.entries.map((e: { kind: string }) => e.kind);
        assert.ok(kinds.includes("event"));
        const agent = body.entries.filter((e: { kind: string }) => e.kind !== "event");
        assert.deepEqual(
          agent.map((e: Record<string, unknown>) => [e.kind, e.text ?? e.name]),
          [["text", "Let me look."], ["call", "run_command"], ["result", "run_command"], ["text", "Done."]],
        );
        const res = agent.find((e: { kind: string }) => e.kind === "result");
        assert.equal(res.isError, true);
        assert.match(res.content, /FAIL greeting/);
        assert.deepEqual(agent[1].input, { argv: ["npm", "test"] });

        // Incremental reads.
        const after = await call(ctx.port, `/api/tasks/greet/transcript?after=${body.last - 1}`);
        assert.equal(after.body.entries.length, 1);
        assert.equal(after.body.last, body.last);

        // QA verdicts land in the transcript with the runner's output.
        const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greeting.txt": "hello\n" });
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit }));
        const qa = await worker(ctx.port, "qa");
        const run = await qa.next();
        assert.equal(run.type, "TEST_EXECUTION");
        qa.send(createMessage("FEEDBACK_LOOP", "qa", {
          taskId: "greet",
          commit,
          outcome: "fail",
          summary: "1 test failed",
          failures: [{ message: "expected hello" }],
          output: "x".repeat(20_000) + "THE END",
        }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.reworkRound === 1);
        const latest = await call(ctx.port, `/api/tasks/greet/transcript?after=${body.last}`);
        const verdict = latest.body.entries.find((e: { kind: string }) => e.kind === "qa");
        assert.equal(verdict.outcome, "fail");
        assert.ok(verdict.output.length < 9000 && verdict.output.endsWith("THE END"), "long output keeps its end");

        assert.equal((await call(ctx.port, "/api/tasks/nope/transcript")).status, 404);
        w.ws.close();
        qa.ws.close();
      },
      { llm: { adapter: model } },
    );
  });

  it("keeps transcripts across a Hub restart and continues numbering", async () => {
    const repoDir = makeTargetRepo();
    try {
      let hub = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", token: TOKEN });
      await postTask(hub.port, { taskId: "api", role: "backend", title: "API", description: "x" });
      await call(hub.port, "/api/tasks/api/cancel", "POST");
      const before = (await call(hub.port, "/api/tasks/api/transcript")).body;
      await hub.close();

      hub = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", token: TOKEN });
      const restored = (await call(hub.port, "/api/tasks/api/transcript")).body;
      assert.deepEqual(restored.entries, before.entries);
      await call(hub.port, "/api/tasks/api/retry", "POST");
      const after = (await call(hub.port, `/api/tasks/api/transcript?after=${before.last}`)).body;
      assert.equal(after.entries[0].seq, before.last + 1);
      assert.match(after.entries.at(-1).text, /retry 1 requested/);
      await hub.close();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("trims long values and ignores unsafe ids", async () => {
    const dir = tempDir();
    try {
      const t = new Transcripts(dir);
      t.append({ kind: "task", id: "../../etc" }, { kind: "event", text: "nope" });
      t.append({ kind: "task", id: "a" }, { kind: "call", id: "tu", name: "write_file", input: { path: "a.ts", content: "y".repeat(5000) } });
      t.append({ kind: "task", id: "a" }, { kind: "result", id: "tu", content: "start" + "z".repeat(50_000) + "end", isError: false });
      await t.flush();
      const { entries } = new Transcripts(dir).read({ kind: "task", id: "a" });
      assert.equal(entries.length, 2);
      const input = (entries[0] as { input: { content: string; path: string } }).input;
      assert.equal(input.path, "a.ts");
      assert.match(input.content, /… \(5000 chars\)$/);
      const content = (entries[1] as { content: string }).content;
      assert.ok(content.startsWith("start") && content.endsWith("end") && content.length < 8200);
      assert.equal(new Transcripts(dir).read({ kind: "task", id: "../../etc" }).entries.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
