import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmError, MachineModels } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import { postTask, reply, ScriptedModel, text, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

function payloadOf<T extends AgentMessage["type"]>(m: AgentMessage, type: T): Extract<AgentMessage, { type: T }>["payload"] {
  assert.equal(m.type, type);
  return (m as Extract<AgentMessage, { type: T }>).payload;
}

/** A Hub whose default agent model must not be reached: a machine's own model does the work. */
const hubOpts = {
  llm: {
    adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")),
    agentAdapter: new ScriptedModel(() => reply([text("from the Hub's model")], "end_turn"), "claude-haiku-5-5"),
    agentModel: "claude-haiku-5-5",
    escalation: false,
  },
};

async function startJob(port: number, w: Awaited<ReturnType<typeof worker>>, nodeId: string, taskId: string) {
  payloadOf(await w.next(), "TASK_ASSIGNMENT");
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "in_progress", taskId, slot: 1 }));
  w.send(createMessage("PROMPT_EXECUTION", nodeId, { requestId: crypto.randomUUID(), taskId, conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
}

describe("a machine's own model (Hub)", () => {
  it("sends the machine's jobs' model calls to the machine, and its answer back to the agent", async () => {
    await withHub(async (ctx) => {
      const gpu = await worker(ctx.port, "gpu", { localModels: [{ id: "qwen3-coder:30b" }, { id: "llama3" }], defaultLocalModel: "qwen3-coder:30b" });
      await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
      await startJob(ctx.port, gpu, "gpu", "greet");

      const call = payloadOf(await gpu.next(), "MODEL_CALL");
      assert.equal(call.model, "qwen3-coder:30b", "its chosen model");
      assert.ok(Array.isArray(call.request.messages) && Array.isArray(call.request.tools), "a ready Chat Completions request");
      gpu.send(createMessage("MODEL_ANSWER", "gpu", { callId: call.callId, outcome: "ok", answer: { content: "done on my GPU", toolCalls: [], finishReason: "stop", usage: { prompt_tokens: 900, completion_tokens: 40 } } }));

      const result = payloadOf(await gpu.next(), "PROMPT_RESULT");
      assert.equal(result.outcome, "ok");
      assert.match(JSON.stringify(result), /done on my GPU/);
      const task = ctx.hub.tasks.get("greet")!;
      assert.ok(task.history.some((h) => /\(machine\/qwen3-coder:30b, this machine's own model\)/.test(h.event)), "the history names it");
      assert.equal(task.llm.costUsd, 0, "free for the Hub");
      gpu.ws.close();
    }, hubOpts);
  });

  it("refuses an answer from another machine, and passes the machine's error on", async () => {
    await withHub(async (ctx) => {
      const gpu = await worker(ctx.port, "gpu", { localModels: [{ id: "qwen" }] });
      await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
      await startJob(ctx.port, gpu, "gpu", "greet");
      const call = payloadOf(await gpu.next(), "MODEL_CALL");

      const other = await worker(ctx.port, "other", { hostname: "other" });
      other.send(createMessage("MODEL_ANSWER", "other", { callId: call.callId, outcome: "ok", answer: { content: "stolen", toolCalls: [], finishReason: "stop" } }));
      assert.match(payloadOf(await other.next(), "PROTOCOL_ERROR").reason, /no model call .* is waiting for other/);

      gpu.send(createMessage("MODEL_ANSWER", "gpu", { callId: call.callId, outcome: "error", error: "out of GPU memory", retryable: true }));
      const result = payloadOf(await gpu.next(), "PROMPT_RESULT");
      assert.ok(result.outcome === "error" && result.retryable && /out of GPU memory/.test(result.error), "its error, to be tried again");
      gpu.ws.close();
      other.ws.close();
    }, hubOpts);
  });

  it("puts a desk on its machine's own model only when that machine serves it", async () => {
    await withHub(async (ctx) => {
      const gpu = await worker(ctx.port, "gpu", { localModels: [{ id: "qwen" }, { id: "llama" }], defaultLocalModel: "qwen" });
      const call = (body: unknown) =>
        fetch(`http://127.0.0.1:${ctx.port}/api/desks`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
      const set = await call({ target: "test#1", model: "machine/llama" });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.deepEqual(set.body.desks, [{ desk: "test#1", model: "machine/llama" }]);
      const refused = await call({ target: "test#1", model: "machine/gpt-5" });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /test doesn't serve gpt-5 itself \(start its worker with --local-model\)/);

      await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
      await startJob(ctx.port, gpu, "gpu", "greet");
      assert.equal(payloadOf(await gpu.next(), "MODEL_CALL").model, "llama", "the desk's choice over the machine's default");
      const nodes = (await fetch(`http://127.0.0.1:${ctx.port}/api/nodes`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())) as Array<{ nodeId: string; localModels?: unknown; defaultLocalModel?: string }>;
      const shown = nodes.find((n) => n.nodeId === "gpu")!;
      assert.deepEqual([shown.localModels, shown.defaultLocalModel], [[{ id: "qwen" }, { id: "llama" }], "qwen"], "the API shows what it serves");
      gpu.ws.close();
    }, hubOpts);
  });

  it("leaves a machine without models on the Hub's model", async () => {
    await withHub(async (ctx) => {
      const plain = await worker(ctx.port, "plain");
      await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
      await startJob(ctx.port, plain, "plain", "greet");
      const result = payloadOf(await plain.next(), "PROMPT_RESULT");
      assert.match(JSON.stringify(result), /from the Hub's model/);
      plain.ws.close();
    }, hubOpts);
  });
});

describe("machine models", () => {
  const req = { system: "s", tools: [], messages: [{ role: "user" as const, content: "x" }] };

  it("fails a call whose machine leaves, so it's tried again, and forgets the machine's models", async () => {
    const sent: unknown[] = [];
    const models = new MachineModels((_nodeId, payload) => sent.push(payload), 1000);
    models.register("gpu", [{ id: "qwen" }]);
    assert.equal(models.defaultSpec("gpu"), "machine/qwen", "its first model when it names none");
    const pending = models.route("gpu", "machine/qwen").adapter.complete(req);
    await waitFor(() => sent.length === 1);
    models.forget("gpu");
    await assert.rejects(pending, (e: unknown) => e instanceof LlmError && e.retryable && /disconnected/.test(e.message));
    assert.equal(models.defaultSpec("gpu"), undefined);
    assert.throws(() => models.route("gpu", "machine/qwen"), /doesn't serve qwen/);
  });

  it("serves only the models a machine listed, on that machine", () => {
    const models = new MachineModels(() => undefined, 1000);
    models.register("gpu", [{ id: "qwen" }, { id: "llama" }], "llama");
    assert.equal(models.defaultSpec("gpu"), "machine/llama");
    assert.throws(() => models.route("gpu", "machine/gpt-5"), /doesn't serve gpt-5/);
    assert.throws(() => models.route("other", "machine/qwen"), /other doesn't serve qwen/);
    assert.equal(models.route("gpu", "machine/qwen").adapter.model, "machine/qwen");
    assert.equal(models.route("gpu", "machine/qwen"), models.route("gpu", "machine/qwen"), "one adapter and one call at a time per model");
    assert.equal(models.answer("gpu", { callId: crypto.randomUUID(), outcome: "error", error: "x", retryable: false }) !== undefined, true, "an answer nobody waits for");
  });
});
