import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { adapterForProfile, ModelProfiles, profileConcurrency, type LlmAdapter } from "@aso/hub";
import { mkdirSync } from "node:fs";
import { createMessage, type AgentMessage } from "@aso/shared";
import { postTask, reply, ScriptedModel, tempDir, text, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const fakeAdapter = (model: string): LlmAdapter => ({ name: "fake", model, complete: async () => reply([text("hi")], "end_turn") });

describe("model profiles", () => {
  it("saves profiles and desks owner-only, and builds each profile's adapter once", async () => {
    const dir = tempDir();
    const built: string[] = [];
    const profiles = await ModelProfiles.open(dir, (def) => (built.push(def.model), fakeAdapter(def.model)), 4);
    await profiles.setProfile("local", { model: "openai:qwen3-coder:30b", baseUrl: "http://avalon:11434/v1" });
    await profiles.setProfile("haiku", { model: "claude-haiku-5-5" });
    await profiles.assign("avalon#1", "local");
    await profiles.assign("avalon#2", "haiku");
    assert.equal(profiles.route("local")!.adapter.model, "openai:qwen3-coder:30b");
    assert.equal(profiles.route("local"), profiles.route("local"), "one adapter and one limit per profile");
    assert.deepEqual(built, ["openai:qwen3-coder:30b", "claude-haiku-5-5"], "built when set, not again on use");

    const file = path.join(dir, "models.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, "utf8"), /key/i, "no secrets in the file");
    const reopened = await ModelProfiles.open(dir, (def) => fakeAdapter(def.model), 4);
    assert.equal(reopened.profileOf("avalon#1"), "local");
    assert.deepEqual(reopened.deskList(), [{ desk: "avalon#1", profile: "local" }, { desk: "avalon#2", profile: "haiku" }]);
  });

  it("limits a local model to one call at once unless told otherwise; Claude gets the Hub's limit", async () => {
    assert.equal(profileConcurrency({ model: "openai:qwen3-coder:30b" }, 4), 1);
    assert.equal(profileConcurrency({ model: "openai:qwen3-coder:30b", concurrency: 2 }, 4), 2);
    assert.equal(profileConcurrency({ model: "claude-haiku-5-5" }, 4), 4);
    const profiles = await ModelProfiles.open(undefined, (def) => fakeAdapter(def.model), 4);
    await profiles.setProfile("local", { model: "openai:m" });
    const slots = profiles.route("local")!.slots;
    let release!: () => void;
    const first = slots.run(() => new Promise<void>((r) => (release = r)));
    const second = slots.run(async () => undefined);
    assert.deepEqual(slots.status(), { running: 1, waiting: 1, limit: 1 }, "the second call waits for the GPU");
    release();
    await Promise.all([first, second]);
  });

  it("refuses a profile it can't build, and an unknown profile for a desk; removing one frees its desks", async () => {
    const profiles = await ModelProfiles.open(undefined, (def) => {
      if (def.model.startsWith("claude")) throw new Error("no ANTHROPIC_API_KEY");
      return fakeAdapter(def.model);
    }, 4);
    await assert.rejects(profiles.setProfile("opus", { model: "claude-opus-5-5" }), /ANTHROPIC_API_KEY/);
    assert.equal(profiles.has("opus"), false, "nothing saved");
    await assert.rejects(profiles.assign("avalon#1", "nope"), /no model profile named nope/);
    await profiles.setProfile("local", { model: "openai:m" });
    await profiles.assign("avalon#1", "local");
    assert.equal(await profiles.removeProfile("local"), true);
    assert.equal(profiles.profileOf("avalon#1"), undefined, "back to the default");
    assert.equal(profiles.route("local"), undefined);
    assert.equal(await profiles.removeProfile("local"), false);
  });

  it("changes nothing when the save fails", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "models.json")); // a folder where the file should go: every save fails
    const profiles = await ModelProfiles.open(dir, (def) => fakeAdapter(def.model), 4);
    await assert.rejects(profiles.setProfile("local", { model: "openai:m" }));
    assert.equal(profiles.has("local"), false);
    assert.equal(profiles.route("local"), undefined);
  });

  it("builds a profile's adapter from its own address, or the Anthropic API with a key", () => {
    const opts = { maxTokens: 1000, effort: "high" as const };
    const local = adapterForProfile({ model: "openai:qwen3-coder:30b", baseUrl: "http://avalon:11434/v1" }, { ...opts, env: {} });
    assert.deepEqual([local.name, local.model], ["openai-compatible", "qwen3-coder:30b"]);
    assert.throws(() => adapterForProfile({ model: "openai:m" }, { ...opts, env: {} }), /needs ASO_LLM_BASE_URL/, "no address in the profile or the Hub");
    assert.equal(adapterForProfile({ model: "openai:m" }, { ...opts, env: { ASO_LLM_BASE_URL: "http://x/v1" } }).model, "m", "the Hub's address as the default");
    assert.throws(() => adapterForProfile({ model: "claude-haiku-5-5" }, { ...opts, env: {} }), /no ANTHROPIC_API_KEY/);
    assert.equal(adapterForProfile({ model: "claude-haiku-5-5" }, { ...opts, env: { ANTHROPIC_API_KEY: "sk-ant-test" } }).name, "anthropic-api");
  });

  it("starts empty from a damaged file, and drops desks whose profile is gone", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "models.json"), "{nope");
    assert.deepEqual((await ModelProfiles.open(dir, (def) => fakeAdapter(def.model), 4)).list(), []);
    writeFileSync(path.join(dir, "models.json"), JSON.stringify({ profiles: { a: { model: "openai:m" } }, desks: { "avalon#1": "a", "avalon#2": "gone" } }));
    const profiles = await ModelProfiles.open(dir, (def) => fakeAdapter(def.model), 4);
    assert.deepEqual(profiles.deskList(), [{ desk: "avalon#1", profile: "a" }]);
  });
});

/** An OpenAI-compatible server that answers every call with "from the profile". */
async function fakeProvider() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "local-model", choices: [{ delta: { content: "from the profile" }, finish_reason: "stop" }] })}\n\n`);
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

describe("desks on model profiles (Hub)", () => {
  it("runs a desk's agent on its profile, and other desks on the default model", async () => {
    const provider = await fakeProvider();
    const defaultModel = new ScriptedModel(() => reply([text("from the default")], "end_turn"), "claude-haiku-5-5");
    try {
      await withHub(
        async (ctx) => {
          const set = await call(ctx.port, "/api/models/profiles/local", { model: "openai:local-model", baseUrl: provider.url });
          assert.equal(set.status, 200, JSON.stringify(set.body));
          assert.equal(set.body.profiles[0].concurrency, 1, "a local model gets one call at once");
          assert.equal((await call(ctx.port, "/api/models/desks", { desk: "test#1", profile: "local" })).status, 200);
          assert.equal((await call(ctx.port, "/api/models/desks", { desk: "test#1", profile: "nope" })).status, 404);
          assert.equal((await call(ctx.port, "/api/models/desks", { desk: "no-slot", profile: "local" })).status, 400);

          // The worker's hostname is "test" and its first job runs at desk 1.
          const w = await worker(ctx.port, "dev");
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
          assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
          w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
          await waitFor(() => ctx.hub.tasks.get("greet")?.state === "in_progress");
          w.send(createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId: "greet", conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
          const r = promptResult(await w.next(5000));
          assert.equal(r.outcome, "ok");
          assert.match(JSON.stringify(r), /from the profile/);
          assert.equal(provider.calls(), 1);
          assert.equal(defaultModel.requests.length, 0, "the default agent model wasn't used");
          assert.ok(ctx.hub.tasks.get("greet")!.history.some((h) => /model profile local: local-model/.test(h.event)), "the task says which model worked on it");

          const models = (await call(ctx.port, "/api/models")).body;
          assert.equal(models.defaultAgent, "claude-haiku-5-5");
          assert.deepEqual(models.desks, [{ desk: "test#1", profile: "local" }]);
          assert.equal((await call(ctx.port, "/api/models/profiles/local/remove", {})).status, 200);
          assert.deepEqual((await call(ctx.port, "/api/models")).body.desks, [], "its desks are back on the default");
          w.ws.close();
        },
        { llm: { adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")), agentAdapter: defaultModel } },
      );
    } finally {
      await provider.close();
    }
  });

  it("refuses a profile the Hub can't use, and bad names", () =>
    withHub(async (ctx) => {
      const claude = await call(ctx.port, "/api/models/profiles/opus", { model: "claude-opus-5-5" });
      assert.equal(claude.status, 400);
      assert.match(claude.body.error, /no ANTHROPIC_API_KEY/);
      assert.equal((await call(ctx.port, "/api/models/profiles/Bad Name", { model: "openai:m", baseUrl: "http://x/v1" })).status, 400);
      assert.equal((await call(ctx.port, "/api/models/profiles/nope/remove", {})).status, 404);
    }));
});
