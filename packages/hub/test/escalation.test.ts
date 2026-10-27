import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { buildEscalationPolicy, calledSpec, canonicalSpec, canSwitchFrom, DEFAULT_JUNIOR_TRIES, roundModel } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import { postTask, reply, ScriptedModel, text, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const policy = { ladder: ["anthropic/claude-sonnet-5-5", "anthropic/claude-opus-5-5"], juniorTries: 2 };
const DEFAULT = "claude-haiku-5-5";

describe("which model a task's round uses", () => {
  it("keeps the desk's model for the junior tries, then climbs the ladder a step per round", () => {
    const at = (reworkRound: number) => roundModel(policy, { reworkRound }, "openai/gpt-5.4-mini", DEFAULT);
    assert.deepEqual(at(0), { spec: "openai/gpt-5.4-mini", why: "this desk's model" });
    assert.deepEqual(at(1), { spec: "openai/gpt-5.4-mini", why: "this desk's model" });
    assert.deepEqual(at(2), { spec: "anthropic/claude-sonnet-5-5", why: "escalated after 2 rework rounds" });
    assert.deepEqual(at(3), { spec: "anthropic/claude-opus-5-5", why: "escalated after 3 rework rounds" });
    assert.deepEqual(at(5), { spec: "anthropic/claude-opus-5-5", why: "escalated after 5 rework rounds" }, "the top of the ladder stays");
  });

  it("uses the default for desks without a model, and calls a ladder step that is the default the default", () => {
    assert.deepEqual(roundModel(policy, { reworkRound: 0 }, undefined, DEFAULT), {});
    assert.deepEqual(roundModel({ ladder: ["claude-haiku-5-5"], juniorTries: 1 }, { reworkRound: 1 }, "openai/gpt-5.4-mini", "anthropic/claude-haiku-5-5"), {
      why: "escalated after 1 rework round",
    });
    assert.deepEqual(roundModel({ ladder: ["x/y"], juniorTries: 0 }, { reworkRound: 0 }, undefined, DEFAULT), { spec: "x/y", why: "the escalation model: no junior tries" });
  });

  it("never escalates without a policy", () => {
    assert.deepEqual(roundModel(undefined, { reworkRound: 9 }, "openai/gpt-5.4-mini", DEFAULT), { spec: "openai/gpt-5.4-mini", why: "this desk's model" });
  });

  it("skips a model that refused the task: to the default, else up the ladder", () => {
    const refusedDesk = { reworkRound: 0, refusedModels: ["gemini/models/gemini-3.8-flash"] };
    assert.deepEqual(roundModel(policy, refusedDesk, "gemini/models/gemini-3.8-flash", DEFAULT), { why: "the default; gemini/models/gemini-3.8-flash refused this task" });
    const bothRefused = { reworkRound: 0, refusedModels: ["gemini/models/gemini-3.8-flash", "anthropic/claude-haiku-5-5"] };
    assert.deepEqual(roundModel(policy, bothRefused, "gemini/models/gemini-3.8-flash", DEFAULT), {
      spec: "anthropic/claude-sonnet-5-5",
      why: "gemini/models/gemini-3.8-flash, anthropic/claude-haiku-5-5 refused this task",
    });
    const ladderStepRefused = { reworkRound: 2, refusedModels: ["anthropic/claude-sonnet-5-5"] };
    assert.deepEqual(roundModel(policy, ladderStepRefused, "openai/gpt-5.4-mini", DEFAULT), { spec: "anthropic/claude-opus-5-5", why: "escalated after 2 rework rounds" });
    const nothingLeft = { reworkRound: 0, refusedModels: ["a/b", "anthropic/claude-haiku-5-5"] };
    assert.deepEqual(roundModel(undefined, nothingLeft, "a/b", DEFAULT), { spec: "a/b", why: "this desk's model" }, "nothing else: the desk's, which fails as before");
  });

  it("says whether another model can take over once one refused", () => {
    assert.equal(canSwitchFrom(undefined, { reworkRound: 0 }, "gemini/x", DEFAULT, "gemini/x"), true, "the default can");
    assert.equal(canSwitchFrom(undefined, { reworkRound: 0 }, undefined, DEFAULT, "anthropic/claude-haiku-5-5"), false, "the default itself refused, and there's no ladder");
    assert.equal(canSwitchFrom(policy, { reworkRound: 0 }, undefined, DEFAULT, "anthropic/claude-haiku-5-5"), true, "the ladder can");
    assert.equal(canSwitchFrom(undefined, { reworkRound: 0, refusedModels: ["anthropic/claude-haiku-5-5"] }, "gemini/x", DEFAULT, "gemini/x"), false, "everything refused");
  });

  it("builds the Hub's policy from its settings", () => {
    const all = () => true;
    assert.deepEqual(buildEscalationPolicy({ model: "anthropic/claude-opus-5-5" }, all), { ladder: ["anthropic/claude-opus-5-5"], juniorTries: DEFAULT_JUNIOR_TRIES }, "default: the Architect's model");
    assert.deepEqual(buildEscalationPolicy({ model: "m", escalateTo: ["a/b", "c/d"], juniorTries: 1 }, all), { ladder: ["a/b", "c/d"], juniorTries: 1 });
    assert.deepEqual(buildEscalationPolicy({ escalateTo: ["a/b", "c/d"] }, (spec) => spec !== "a/b"), { ladder: ["c/d"], juniorTries: 2 }, "unusable models left out");
    assert.equal(buildEscalationPolicy({ model: "m", escalation: false }, all), undefined);
    assert.equal(buildEscalationPolicy({}, all), undefined, "nothing to escalate to");
    assert.equal(buildEscalationPolicy({ escalateTo: ["a/b"] }, () => false), undefined);
  });

  it("compares models in one form", () => {
    assert.equal(canonicalSpec("claude-haiku-5-5"), "anthropic/claude-haiku-5-5");
    assert.equal(canonicalSpec("openai:qwen3-coder:30b"), "local/qwen3-coder:30b");
    assert.equal(calledSpec({}, "claude-haiku-5-5"), "anthropic/claude-haiku-5-5");
    assert.equal(calledSpec({ spec: "openai/gpt-5" }, DEFAULT), "openai/gpt-5");
    assert.equal(calledSpec({}, undefined), undefined);
  });
});

/** An OpenAI-compatible server offering `bad-model` (every call refused with HTTP 400) and `good-model`. */
async function fakeProvider() {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "bad-model" }, { id: "good-model" }] }));
      const model = (JSON.parse(raw) as { model: string }).model;
      calls.push(model);
      if (model === "bad-model") return void res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"Function call is missing a thought_signature"}}');
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ model, choices: [{ delta: { content: `from ${model}` }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const call = (port: number, route: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

function promptResult(m: AgentMessage) {
  assert.equal(m.type, "PROMPT_RESULT");
  return m.type === "PROMPT_RESULT" ? m.payload : assert.fail();
}

/** Start the task's agent on desk test#1 and ask for its first turn. */
async function firstTurn(w: Awaited<ReturnType<typeof worker>>, taskId: string) {
  assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
  w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId, slot: 1 }));
  w.send(createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId, conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
  return promptResult(await w.next(5000));
}

describe("escalation (Hub)", () => {
  it("moves a task whose model refuses it to another model instead of failing it", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    const fallback = new ScriptedModel(() => reply([text("from the default")], "end_turn"), "claude-haiku-5-5");
    try {
      await withHub(
        async (ctx) => {
          const w = await worker(ctx.port, "dev");
          assert.equal((await call(ctx.port, "/api/desks", { target: "test#1", model: "bad-model" })).status, 200);
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });

          const refused = await firstTurn(w, "greet");
          assert.equal(refused.outcome, "error");
          await waitFor(() => ctx.hub.tasks.get("greet")?.switchingModel === true);
          w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "greet", detail: "bad request (400)" }));

          const retried = await firstTurn(w, "greet");
          assert.equal(retried.outcome, "ok");
          assert.match(JSON.stringify(retried), /from the default/);
          const task = ctx.hub.tasks.get("greet")!;
          assert.equal(task.state, "in_progress", "requeued, not failed");
          assert.equal(task.reworkRound, 0, "a refusal isn't a rework round");
          assert.deepEqual(task.refusedModels, ["local/bad-model"]);
          assert.deepEqual(provider.calls, ["bad-model"]);
          const events = task.history.map((h) => h.event).join("\n");
          assert.match(events, /local\/bad-model refused the request \(.*thought_signature.*\); the task moves to another model/);
          assert.match(events, /requeued for another model/);
          assert.match(events, /\(claude-haiku-5-5, the default; local\/bad-model refused this task\)/);
          w.ws.close();
        },
        { llm: { adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")), agentAdapter: fallback, agentModel: "claude-haiku-5-5", escalation: false } },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });

  it("fails the task as before when no other model can take it", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    try {
      await withHub(
        async (ctx) => {
          const w = await worker(ctx.port, "dev");
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
          assert.equal((await firstTurn(w, "greet")).outcome, "error");
          w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "greet", detail: "bad request (400)" }));
          await waitFor(() => ctx.hub.tasks.get("greet")?.state === "failed");
          assert.equal(ctx.hub.tasks.get("greet")!.refusedModels, undefined);
          w.ws.close();
        },
        { llm: { model: "local/bad-model", agentModel: "local/bad-model", escalation: false } },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });

  it("takes a ladder set while the Hub runs from the next round, and goes back to the start settings", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    try {
      await withHub(
        async (ctx) => {
          assert.equal((await call(ctx.port, "/api/desks")).body.escalation, null, "started without escalation");
          const set = await call(ctx.port, "/api/models/escalation", { ladder: ["good-model"], juniorTries: 0 });
          assert.equal(set.status, 200, JSON.stringify(set.body));
          assert.deepEqual(set.body.escalation, { ladder: ["local/good-model"], juniorTries: 0 });
          assert.deepEqual(set.body.escalationSet, { ladder: ["local/good-model"], juniorTries: 0 });

          const w = await worker(ctx.port, "dev");
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
          const r = await firstTurn(w, "greet");
          assert.match(JSON.stringify(r), /from good-model/, "the round ran on the new ladder");

          for (const body of [{}, { ladder: [] }, { ladder: ["default"] }, { ladder: ["machine/llama"] }, { ladder: ["no-such-model"] }, { juniorTries: -1 }, { ladder: "default", extra: 1 }]) {
            assert.equal((await call(ctx.port, "/api/models/escalation", body)).status, 400, JSON.stringify(body));
          }
          const back = await call(ctx.port, "/api/models/escalation", { ladder: "default", juniorTries: "default" });
          assert.equal(back.status, 200);
          assert.equal(back.body.escalation, null, "off again, as it started");
          assert.deepEqual(back.body.escalationSet, {});
          w.ws.close();
        },
        {
          llm: {
            adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")),
            agentAdapter: new ScriptedModel(() => assert.fail("the junior model was used"), "claude-haiku-5-5"),
            agentModel: "claude-haiku-5-5",
            escalation: false,
          },
        },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });

  it("starts a round on the ladder's model once the junior tries are used up", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    try {
      await withHub(
        async (ctx) => {
          const w = await worker(ctx.port, "dev");
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
          const r = await firstTurn(w, "greet");
          assert.equal(r.outcome, "ok");
          assert.match(JSON.stringify(r), /from good-model/);
          assert.match(ctx.hub.tasks.get("greet")!.history.map((h) => h.event).join("\n"), /\(good-model, the escalation model: no junior tries\)/);
          w.ws.close();
        },
        {
          llm: {
            adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")),
            agentAdapter: new ScriptedModel(() => assert.fail("the junior model was used"), "claude-haiku-5-5"),
            agentModel: "claude-haiku-5-5",
            escalateTo: ["local/good-model", "nope/missing"],
            juniorTries: 0,
          },
        },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });
});
