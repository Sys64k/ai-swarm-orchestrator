import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CustomPrices, environmentProviders, fetchModels, parseModelList, parseSpec, priceTable, priceUsage, Providers, resolveModel, unpricedWarning, type Provider } from "@aso/hub";
import type { AvailableModel } from "@aso/shared";
import { tempDir, TOKEN, withHub } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

/** An OpenAI-compatible API: lists `ids` (with OpenRouter-style prices) to the right key, refuses a wrong one. */
async function fakeApi(ids: string[], key?: string) {
  const seen: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""}`);
    if (key && req.headers.authorization !== `Bearer ${key}`) return void res.writeHead(401).end('{"error":"bad key"}');
    if (req.url?.endsWith("/chat/completions")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      const chunk = { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      return void res.writeHead(200, { "content-type": "text/event-stream" }).end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    }
    if (req.url?.endsWith("/responses")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      bodies.push({ ...(JSON.parse(raw) as Record<string, unknown>), url: req.url });
      const done = { type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } } };
      return void res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: response.completed\ndata: ${JSON.stringify(done)}\n\n`);
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: ids.map((id) => ({ id, pricing: { prompt: "0.000001", completion: "0.000002" } })) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen, bodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("providers", () => {
  it("reads model specs in the new and the older forms", () => {
    const providers = [{ id: "anthropic" }, { id: "openrouter" }, { id: "local" }];
    const of = (providerId: string, model: string, explicit = true) => ({ providerId, model, spec: `${providerId}/${model}`, explicit });
    assert.deepEqual(parseSpec("anthropic/claude-haiku-5-5", providers), of("anthropic", "claude-haiku-5-5"));
    assert.deepEqual(parseSpec("openrouter/meta-llama/llama-3.3-70b", providers), of("openrouter", "meta-llama/llama-3.3-70b"), "a model with its own slashes");
    assert.deepEqual(parseSpec("claude-opus-5-5", providers), of("anthropic", "claude-opus-5-5", false), "a bare Claude id, as --model has always taken");
    assert.deepEqual(parseSpec("openai:qwen3-coder:30b", providers), of("local", "qwen3-coder:30b"), "the .env's server");
    assert.ok("error" in parseSpec("gpt-5", providers));
  });

  it("turns the .env into providers, so a Hub set up the old way keeps working", () => {
    const env = environmentProviders({ ANTHROPIC_API_KEY: "sk-ant", ASO_LLM_BASE_URL: "http://avalon:11434/v1/", ASO_LLM_VISION: "1" });
    assert.deepEqual(env.map((p) => [p.id, p.kind, p.source, p.baseUrl ?? null, p.vision ?? false]), [
      ["anthropic", "anthropic", "environment", null, false],
      ["local", "openai-compatible", "environment", "http://avalon:11434/v1", true],
    ]);
    assert.equal(env[1].label, "Local (avalon:11434)");
    assert.deepEqual(environmentProviders({}), []);
    const cloud = environmentProviders({ OPENAI_API_KEY: "sk-oa", GEMINI_API_KEY: " g-key ", GROQ_API_KEY: "", OLLAMA_API_KEY: "ol-key" });
    assert.deepEqual(cloud.map((p) => [p.id, p.preset, p.source, p.key, p.baseUrl]), [
      ["openai", "openai", "environment", "sk-oa", "https://api.openai.com/v1"],
      ["gemini", "gemini", "environment", "g-key", "https://generativelanguage.googleapis.com/v1beta/openai"],
      ["ollama-cloud", "ollama-cloud", "environment", "ol-key", "https://ollama.com/v1"],
    ], "each cloud key in the .env is a provider at its known address; an empty one isn't");
  });

  it("adds a provider only when its key works, keeps keys owner-only and never shows them", async () => {
    const api = await fakeApi(["gpt-5", "gpt-5-mini"], "sk-right");
    try {
      const dir = tempDir();
      const providers = await Providers.open(dir, {});
      await assert.rejects(providers.add({ preset: "custom", id: "remote", baseUrl: api.url, key: "sk-wrong" }), /can't use Custom .*HTTP 401 \(the key was refused\)/);
      assert.equal(providers.get("remote"), undefined, "nothing saved");
      await assert.rejects(providers.add({ preset: "openai" }), /OpenAI needs an API key/);
      await assert.rejects(providers.add({ preset: "ollama-cloud" }), /Ollama Cloud needs an API key/, "unlike a local Ollama");
      await assert.rejects(providers.add({ preset: "ollama" }), /needs the server's address/);

      const added = await providers.add({ preset: "custom", id: "remote", baseUrl: `${api.url}/`, key: "sk-right" });
      assert.equal(added.baseUrl, api.url, "the trailing slash dropped");
      const file = path.join(dir, "providers.json");
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.deepEqual([added.hasKey, added.models], [true, 2]);
      assert.ok(!JSON.stringify(added).includes("sk-right"), "the API never shows a key");
      assert.ok(!JSON.stringify(await providers.views()).includes("sk-right"));
      assert.equal((await Providers.open(dir, {})).get("remote")?.key, "sk-right", "kept across restarts");

      const { models } = await providers.models();
      assert.deepEqual(models.map((m) => m.spec), ["remote/gpt-5", "remote/gpt-5-mini"]);
      assert.equal(models[0].providerLabel, "Custom (" + new URL(api.url).host + ")");
      assert.equal(priceUsage("gpt-5", { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 }).costUsd, 3, "prices the provider reported");

      assert.equal(await providers.remove("remote"), "removed");
      assert.doesNotMatch(readFileSync(file, "utf8"), /sk-right/, "the key is forgotten");
      assert.equal(await providers.remove("remote"), "missing");
    } finally {
      await api.close();
    }
  });

  it("builds adapters per provider, and says what's missing", async () => {
    const providers = await Providers.open(undefined, { ANTHROPIC_API_KEY: "sk-ant-test", ASO_LLM_BASE_URL: "http://avalon:11434/v1" });
    const opts = { maxTokens: 1000, effort: "high" as const };
    assert.equal(providers.adapterFor("anthropic/claude-haiku-5-5", opts).name, "anthropic-api");
    assert.equal(providers.adapterFor("claude-haiku-5-5", opts).model, "claude-haiku-5-5");
    const local = providers.adapterFor("local/qwen3-coder:30b", opts);
    assert.deepEqual([local.name, local.model], ["openai-compatible", "qwen3-coder:30b"]);
    assert.equal(providers.isLocal("local/qwen3-coder:30b"), true, "one GPU: one call at once");
    assert.equal(providers.isLocal("anthropic/claude-haiku-5-5"), false);

    const none = await Providers.open(undefined, {});
    assert.throws(() => none.adapterFor("claude-haiku-5-5", opts), /no Anthropic provider/);
    assert.throws(() => none.adapterFor("openai:m", opts), /needs ASO_LLM_BASE_URL/);
  });

  it("falls back to the known Claude models when Anthropic can't be reached", async () => {
    const offline: typeof fetch = async () => {
      throw new Error("offline");
    };
    const providers = await Providers.open(undefined, { ANTHROPIC_API_KEY: "sk-ant-test" }, offline);
    const { models, status } = await providers.models();
    assert.ok(models.some((m) => m.spec === "anthropic/claude-haiku-5-5"));
    assert.match(status.get("anthropic")!.error!, /offline|Connection error/);
  });

  it("resolves what a person types to one model, or explains", () => {
    const available: AvailableModel[] = [
      { model: "claude-haiku-5-5", spec: "anthropic/claude-haiku-5-5", provider: "anthropic", providerId: "anthropic" },
      { model: "qwen3-coder:30b", spec: "ollama/qwen3-coder:30b", provider: "openai-compatible", providerId: "ollama" },
      { model: "gpt-5", spec: "openai/gpt-5", provider: "openai-compatible", providerId: "openai" },
      { model: "gpt-5", spec: "openrouter/gpt-5", provider: "openai-compatible", providerId: "openrouter" },
    ];
    const ids = [{ id: "anthropic" }, { id: "ollama" }, { id: "openai" }, { id: "openrouter" }];
    assert.deepEqual(resolveModel("qwen3-coder:30b", available, ids), { spec: "ollama/qwen3-coder:30b" });
    assert.deepEqual(resolveModel("anthropic/claude-haiku-5-5", available, ids), { spec: "anthropic/claude-haiku-5-5" });
    const twice = resolveModel("gpt-5", available, ids);
    assert.ok("error" in twice && /several providers offer "gpt-5": choose one of "openai\/gpt-5", "openrouter\/gpt-5"/.test(twice.error));
    assert.deepEqual(resolveModel("openai/gpt-6", available, ids), { spec: "openai/gpt-6" }, "a model a provider doesn't list yet");
    const typo = resolveModel("qwen", available, ids);
    assert.ok("error" in typo && /Did you mean "qwen3-coder:30b"/.test(typo.error));
    const empty = resolveModel("x", [], []);
    assert.ok("error" in empty && /aso provider add/.test(empty.error));
  });

  it("reads an OpenAI-style model list and OpenRouter's per-token prices", () => {
    const list = parseModelList({ data: [{ id: "b", pricing: { prompt: "0.000003", completion: "0.000015" } }, { id: "a", object: "model" }, { id: "c", pricing: { prompt: "free" } }] });
    assert.deepEqual(list.ids, ["a", "b", "c"]);
    assert.deepEqual(Object.keys(list.prices), ["b"], "no price from a missing or unreadable one");
    assert.ok(Math.abs(list.prices.b.input - 3) < 1e-9 && Math.abs(list.prices.b.output - 15) < 1e-9, "per million tokens");
    assert.throws(() => parseModelList({ models: [] }), /isn't an OpenAI-style one/);
    assert.deepEqual(parseModelList({ data: [] }).ids, [], "a server with no models yet");
  });

  it("defaults the Architect to Claude Opus only when Anthropic is a provider", async () => {
    assert.equal((await Providers.open(undefined, { ANTHROPIC_API_KEY: "sk-ant-test" })).defaultModel(), "claude-opus-5-5");
    assert.equal((await Providers.open(undefined, { ASO_LLM_BASE_URL: "http://avalon:11434/v1" })).defaultModel(), undefined, "the person chooses");
  });

  it("asks OpenAI's models on its Responses API, other providers on Chat Completions", async () => {
    const api = await fakeApi(["gpt-5"], "sk-oa");
    try {
      const providers = await Providers.open(undefined, {});
      await providers.add({ preset: "openai", key: "sk-oa", baseUrl: api.url });
      await providers.add({ preset: "custom", id: "lab", baseUrl: api.url, key: "sk-oa" });
      const opts = { maxTokens: 1000, effort: "high" as const };
      await providers.adapterFor("openai/gpt-5", opts).complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] });
      await providers.adapterFor("lab/gpt-5", opts).complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] });
      const [openAi, lab] = api.bodies;
      assert.deepEqual([openAi.url, openAi.max_output_tokens, openAi.store], ["/v1/responses", 1000, false], "nothing stored at OpenAI");
      assert.deepEqual([lab.max_tokens, "max_completion_tokens" in lab, "url" in lab], [1000, false, false]);
    } finally {
      await api.close();
    }
  });

  it("keeps prices set on the Hub, which win over the built-in ones, and charges with them", async () => {
    const dir = tempDir();
    const prices = await CustomPrices.open(dir);
    const million = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 };
    assert.equal(priceUsage("qwen3-coder:30b", million).costUsd, 0, "unknown: $0");
    await prices.set("qwen3-coder:30b", { input: 0.5, output: 1 });
    await prices.set("claude-haiku-5-5", { input: 1, output: 2 });
    assert.equal(priceUsage("qwen3-coder:30b", million).costUsd, 1.5);
    assert.equal(priceUsage("claude-haiku-5-5", million).costUsd, 3, "a set price wins over the built-in one");
    assert.deepEqual(priceTable().filter((p) => p.model === "claude-haiku-5-5").map((p) => p.source), ["set"]);
    await CustomPrices.open(dir); // a restart reads them back
    assert.equal(priceUsage("qwen3-coder:30b", million).costUsd, 1.5);
    assert.equal(await prices.remove("claude-haiku-5-5"), true);
    assert.equal(priceUsage("claude-haiku-5-5", million).costUsd, 0.6, "back to the built-in price");
    assert.equal(await prices.remove("claude-haiku-5-5"), false);
    await prices.remove("qwen3-coder:30b");
  });

  it("prices the older Opus models desks can still be put on", () => {
    const task = { inputTokens: 0, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 };
    for (const model of ["claude-opus-4-7", "claude-opus-4-6"]) assert.equal(priceUsage(model, task).costUsd, 31.75, model);
  });

  it("warns about an Anthropic model with no price, and only that", async () => {
    assert.match(unpricedWarning("anthropic/claude-opus-4-1") ?? "", /no price known for claude-opus-4-1; its cost will read \$0/);
    assert.equal(unpricedWarning("anthropic/claude-opus-4-7"), undefined, "a built-in price");
    assert.equal(unpricedWarning("local/qwen3-coder:30b"), undefined, "an OpenAI-compatible model may be free");
    assert.equal(unpricedWarning("machine/qwen3-coder:30b"), undefined, "a machine's own model costs nothing");
    const prices = await CustomPrices.open(tempDir());
    await prices.set("claude-opus-4-1", { input: 15, output: 75 });
    assert.equal(unpricedWarning("anthropic/claude-opus-4-1"), undefined, "a price set on the Hub");
    await prices.remove("claude-opus-4-1");
  });

  it("charges cached input at its own rate when one is set", async () => {
    const prices = await CustomPrices.open(tempDir());
    // A Gemini agent's task: most input is read from the cache, at a tenth of the input price.
    const task = { inputTokens: 1e6, outputTokens: 1e5, cacheReadTokens: 20e6, cacheWriteTokens: 0 };
    await prices.set("models/gemini-3.8-flash", { input: 0.75, output: 3.75 });
    assert.equal(priceUsage("models/gemini-3.8-flash", task).costUsd, 16.125, "without a cache rate: every cached token at the input price");
    await prices.set("models/gemini-3.8-flash", { input: 0.75, output: 3.75, cacheRead: 0.075 });
    assert.equal(priceUsage("models/gemini-3.8-flash", task).costUsd, 2.625);
    const entry = priceTable().find((p) => p.model === "models/gemini-3.8-flash")!;
    assert.deepEqual([entry.cacheRead, entry.cacheWrite], [0.075, 0.75]);
    await prices.remove("models/gemini-3.8-flash");
  });

  it("lets a provider added on the Hub take over the .env's with the same name", async () => {
    const api = await fakeApi(["gpt-5"], "sk-added");
    try {
      const providers = await Providers.open(undefined, { OPENAI_API_KEY: "sk-env" });
      assert.equal(providers.get("openai")?.source, "environment");
      await providers.add({ preset: "openai", key: "sk-added", baseUrl: api.url });
      assert.deepEqual([providers.get("openai")?.source, providers.get("openai")?.key], ["added", "sk-added"]);
      assert.equal(providers.list().filter((p) => p.id === "openai").length, 1);
    } finally {
      await api.close();
    }
  });

  it("keeps .env providers removable only there", async () => {
    const providers = await Providers.open(undefined, { ANTHROPIC_API_KEY: "sk-ant-test" });
    assert.equal(await providers.remove("anthropic"), "environment");
  });

  it("asks an OpenAI-compatible API for its models with the key", async () => {
    const api = await fakeApi(["b", "a"], "k");
    try {
      const p: Provider = { id: "x", preset: "custom", kind: "openai-compatible", baseUrl: api.url, key: "k", source: "added", label: "X" };
      assert.deepEqual((await fetchModels(p)).ids, ["a", "b"]);
      assert.match(api.seen[0], /^GET \/v1\/models Bearer k$/);
    } finally {
      await api.close();
    }
  });
});

const call = (port: number, route: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe("providers (Hub)", () => {
  it("adds a provider over the API, lists its models, and never answers with the key", async () => {
    const api = await fakeApi(["llama3.3:70b"], "sk-secret");
    try {
      await withHub(async (ctx) => {
        const refused = await call(ctx.port, "/api/providers", { preset: "custom", id: "remote", baseUrl: api.url, key: "nope" });
        assert.equal(refused.status, 400);
        assert.match(refused.body.error, /the key was refused/);
        const added = await call(ctx.port, "/api/providers", { preset: "custom", id: "remote", baseUrl: api.url, key: "sk-secret" });
        assert.equal(added.status, 201, JSON.stringify(added.body));
        assert.deepEqual([added.body.id, added.body.hasKey, added.body.models], ["remote", true, 1]);
        const list = await call(ctx.port, "/api/providers");
        assert.ok(!JSON.stringify(list.body).includes("sk-secret"), "no key in any answer");
        const models = (await call(ctx.port, "/api/models")).body;
        assert.deepEqual(models.available.map((m: AvailableModel) => [m.spec, m.providerLabel]), [["remote/llama3.3:70b", `Custom (${new URL(api.url).host})`]]);
        assert.equal((await call(ctx.port, "/api/desks", { target: "test#1", model: "llama3.3:70b" })).status, 200, "a desk on it by name");
        const priced = await call(ctx.port, "/api/prices", { model: "remote/llama3.3:70b", input: 0.2, output: 0.4 });
        assert.deepEqual(priced.body, { model: "llama3.3:70b", input: 0.2, output: 0.4, cacheRead: 0.2, cacheWrite: 0.2, source: "set" }, "priced per model name; cache rates default to the input price");
        assert.equal((await call(ctx.port, "/api/prices", { model: "x", input: -1, output: 0 })).status, 400);
        assert.equal((await call(ctx.port, "/api/prices/remove", { model: "llama3.3:70b" })).status, 200);
        assert.equal((await call(ctx.port, "/api/prices/remove", { model: "llama3.3:70b" })).status, 404);
        assert.equal((await call(ctx.port, "/api/providers/remote/remove", {})).status, 200);
        assert.equal((await call(ctx.port, "/api/providers/remote/remove", {})).status, 404);
      });
    } finally {
      await api.close();
    }
  });
});
