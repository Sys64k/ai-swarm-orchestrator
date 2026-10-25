import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { adapterForModel, DeskModels, desksOf, ModelCatalog, modelConcurrency, resolveModel, type LlmAdapter } from "@aso/hub";
import { createMessage, type AgentMessage, type AvailableModel } from "@aso/shared";
import { postTask, reply, ScriptedModel, tempDir, text, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const fakeAdapter = (model: string): LlmAdapter => ({ name: "fake", model, complete: async () => reply([text("hi")], "end_turn") });
const open = (dir?: string) => DeskModels.open(dir, (spec) => fakeAdapter(spec), 4);

describe("desk models", () => {
  it("saves which model each desk uses, owner-only and without secrets, and drops unused settings", async () => {
    const dir = tempDir();
    const desks = await open(dir);
    await desks.assign(["avalon#1", "avalon#2"], "openai:qwen3-coder:30b", { concurrency: 2 });
    await desks.assign(["canfod#1"], "claude-haiku-5-5");
    assert.equal(desks.modelOf("avalon#2"), "openai:qwen3-coder:30b");
    assert.equal(desks.route("openai:qwen3-coder:30b"), desks.route("openai:qwen3-coder:30b"), "one adapter and limit per model");

    const file = path.join(dir, "models.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, "utf8"), /key/i);
    const reopened = await open(dir);
    assert.deepEqual(reopened.view("opus", "haiku").desks, [
      { desk: "avalon#1", model: "openai:qwen3-coder:30b" },
      { desk: "avalon#2", model: "openai:qwen3-coder:30b" },
      { desk: "canfod#1", model: "claude-haiku-5-5" },
    ]);
    assert.equal(reopened.view(null, null).models.find((m) => m.model === "openai:qwen3-coder:30b")!.concurrency, 2, "settings survive a restart");

    await reopened.assign(["avalon#1", "avalon#2"], null);
    assert.equal(reopened.modelOf("avalon#1"), undefined, "back on the default");
    assert.doesNotMatch(readFileSync(file, "utf8"), /qwen/, "a model no desk uses is forgotten");
  });

  it("gives a local model one call at once unless told otherwise; Claude gets the Hub's limit", async () => {
    assert.equal(modelConcurrency("openai:m", {}, 4), 1);
    assert.equal(modelConcurrency("openai:m", { concurrency: 3 }, 4), 3);
    assert.equal(modelConcurrency("claude-haiku-5-5", {}, 4), 4);
    const desks = await open();
    await desks.assign(["avalon#1"], "openai:m");
    const slots = desks.route("openai:m").slots;
    let release!: () => void;
    const first = slots.run(() => new Promise<void>((r) => (release = r)));
    const second = slots.run(async () => undefined);
    assert.deepEqual(slots.status(), { running: 1, waiting: 1, limit: 1 }, "the second call waits for the GPU");
    release();
    await Promise.all([first, second]);
  });

  it("refuses a model it can't use, and a failed save changes nothing", async () => {
    const strict = await DeskModels.open(undefined, (spec) => {
      if (spec.startsWith("claude")) throw new Error("no ANTHROPIC_API_KEY");
      return fakeAdapter(spec);
    }, 4);
    await assert.rejects(strict.assign(["avalon#1"], "claude-opus-5-5"), /ANTHROPIC_API_KEY/);
    assert.equal(strict.modelOf("avalon#1"), undefined);

    const dir = tempDir();
    mkdirSync(path.join(dir, "models.json")); // a folder where the file goes: every save fails
    const broken = await open(dir);
    await assert.rejects(broken.assign(["avalon#1"], "openai:m"));
    assert.equal(broken.modelOf("avalon#1"), undefined);
  });

  it("starts with every desk on the default from a damaged file", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "models.json"), "{nope");
    assert.deepEqual((await open(dir)).view(null, null).desks, []);
  });

  it("turns a machine into its desks, and a desk into itself", () => {
    const workers = [{ hostname: "avalon", slots: 4 }, { hostname: "canfod", slots: 2 }];
    assert.deepEqual(desksOf("avalon#3", workers), ["avalon#3"]);
    assert.deepEqual(desksOf("canfod", workers), ["canfod#1", "canfod#2"]);
    const gone = desksOf("asusmini", workers);
    assert.ok(!Array.isArray(gone) && /asusmini isn't connected \(connected: avalon, canfod\); name a desk instead, e\.g\. asusmini#1/.test(gone.error));
  });

  it("builds a model's adapter from its own address, or the Anthropic API with a key", () => {
    const opts = { maxTokens: 1000, effort: "high" as const };
    const local = adapterForModel("openai:qwen3-coder:30b", { baseUrl: "http://avalon:11434/v1" }, { ...opts, env: {} });
    assert.deepEqual([local.name, local.model], ["openai-compatible", "qwen3-coder:30b"]);
    assert.throws(() => adapterForModel("openai:m", {}, { ...opts, env: {} }), /needs ASO_LLM_BASE_URL/);
    assert.equal(adapterForModel("openai:m", {}, { ...opts, env: { ASO_LLM_BASE_URL: "http://x/v1" } }).model, "m");
    assert.throws(() => adapterForModel("claude-haiku-5-5", {}, { ...opts, env: {} }), /no ANTHROPIC_API_KEY/);
    assert.equal(adapterForModel("claude-haiku-5-5", {}, { ...opts, env: { ANTHROPIC_API_KEY: "sk-ant-test" } }).name, "anthropic-api");
  });
});

describe("model catalog", () => {
  const available: AvailableModel[] = [
    { model: "claude-haiku-5-5", spec: "claude-haiku-5-5", provider: "anthropic" },
    { model: "claude-opus-5-5", spec: "claude-opus-5-5", provider: "anthropic" },
    { model: "qwen3-coder:30b", spec: "openai:qwen3-coder:30b", provider: "openai-compatible", baseUrl: "http://avalon:11434/v1" },
  ];

  it("takes a model by the name it's listed under, or an explicit openai: one", () => {
    assert.deepEqual(resolveModel("qwen3-coder:30b", available), { spec: "openai:qwen3-coder:30b" });
    assert.deepEqual(resolveModel(" claude-haiku-5-5 ", available), { spec: "claude-haiku-5-5" });
    assert.deepEqual(resolveModel("openai:llama3.3:70b", available), { spec: "openai:llama3.3:70b" }, "on another server, with --base-url");
    assert.deepEqual(resolveModel("claude-sonnet-5-5", available), { spec: "claude-sonnet-5-5" }, "a priced Claude model it doesn't list");
  });

  it("suggests the closest names for a typo", () => {
    const qwen = resolveModel("qwen3", available);
    assert.ok("error" in qwen && /Did you mean "qwen3-coder:30b"\?/.test(qwen.error));
    const haiku = resolveModel("claude-hiaku-5-5", available);
    assert.ok("error" in haiku && /Did you mean "claude-haiku-5-5"\?/.test(haiku.error));
    const none = resolveModel("gpt", []);
    assert.ok("error" in none && /set ANTHROPIC_API_KEY or ASO_LLM_BASE_URL/.test(none.error));
  });

  it("lists Claude with a key, and the local server's models", async () => {
    const server = http.createServer((req, res) => {
      assert.equal(req.url, "/v1/models");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen3-coder:30b" }, { id: "llama3.3:70b" }, { nope: 1 }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    try {
      const { models } = await new ModelCatalog({ ANTHROPIC_API_KEY: "k", ASO_LLM_BASE_URL: `${url}/` }).list();
      assert.deepEqual(models.filter((m) => m.provider === "openai-compatible").map((m) => [m.model, m.spec, m.baseUrl]), [
        ["llama3.3:70b", "openai:llama3.3:70b", url],
        ["qwen3-coder:30b", "openai:qwen3-coder:30b", url],
      ]);
      assert.ok(models.some((m) => m.model === "claude-haiku-5-5"));
      assert.ok(!(await new ModelCatalog({}).list()).models.length, "no key, no server: nothing to choose");
    } finally {
      server.close();
    }
    const down = await new ModelCatalog({ ASO_LLM_BASE_URL: "http://127.0.0.1:1/v1" }).list();
    assert.match(down.localError ?? "", /can't be reached/);
  });
});

/** An OpenAI-compatible server: lists one model, and answers every call with "from the desk's model". */
async function fakeProvider() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/models")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "local-model" }] }));
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "local-model", choices: [{ delta: { content: "from the desk's model" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls: () => calls, close: () => new Promise<void>((r) => server.close(() => r())) };
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

describe("desks on their own models (Hub)", () => {
  it("lists the local models, puts a desk on one by name, and runs its agent there", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    const defaultModel = new ScriptedModel(() => reply([text("from the default")], "end_turn"), "claude-haiku-5-5");
    try {
      await withHub(
        async (ctx) => {
          const models = (await call(ctx.port, "/api/models")).body;
          assert.deepEqual(models.available.map((m: AvailableModel) => m.model), ["local-model"]);

          // The worker's hostname is "test", with desks test#1...
          const w = await worker(ctx.port, "dev");
          const set = await call(ctx.port, "/api/desks", { target: "test#1", model: "local-model" });
          assert.equal(set.status, 200, JSON.stringify(set.body));
          assert.deepEqual(set.body.desks, [{ desk: "test#1", model: "openai:local-model" }]);
          assert.equal(set.body.models[0].concurrency, 1, "a local model gets one call at once");
          const typo = await call(ctx.port, "/api/desks", { target: "test#1", model: "local" });
          assert.equal(typo.status, 400);
          assert.match(typo.body.error, /Did you mean "local-model"/);
          assert.equal((await call(ctx.port, "/api/desks", { target: "elsewhere", model: "local-model" })).status, 404);

          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
          assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
          w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
          await waitFor(() => ctx.hub.tasks.get("greet")?.state === "in_progress");
          w.send(createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId: "greet", conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
          const r = promptResult(await w.next(5000));
          assert.equal(r.outcome, "ok");
          assert.match(JSON.stringify(r), /from the desk's model/);
          assert.equal(provider.calls(), 1);
          assert.equal(defaultModel.requests.length, 0, "the default agent model wasn't used");
          assert.ok(ctx.hub.tasks.get("greet")!.history.some((h) => /\(local-model, this desk's model\)/.test(h.event)), "the task says which model worked on it");

          const whole = await call(ctx.port, "/api/desks", { target: "test", model: "default" });
          assert.deepEqual(whole.body.desks, [], "the whole machine back on the default");
          w.ws.close();
        },
        { llm: { adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")), agentAdapter: defaultModel } },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });
});
