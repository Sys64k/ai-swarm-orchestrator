import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import {
  accumulateChunks,
  classifyHttp,
  fromChatAnswer,
  LlmError,
  openAiCompatibleFor,
  sseData,
  startHub,
  toChatMessages,
  toChatTools,
} from "@aso/hub";
import { makeTargetRepo, TOKEN } from "./helpers.ts";

const TOOL = { name: "read_file", description: "Read a file", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } };

describe("OpenAI-compatible models: translation", () => {
  it("turns the Hub's conversation into Chat Completions messages", () => {
    const messages = toChatMessages(
      "You are a builder.",
      [
        { role: "user", content: "Add a footer." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private", signature: "sig" },
            { type: "text", text: "Reading it first." },
            { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "export {}" },
            { type: "text", text: "[ASO] 3 turns left." },
          ],
        },
      ] as never,
      { vision: false },
    );
    assert.deepEqual(messages, [
      { role: "system", content: "You are a builder." },
      { role: "user", content: "Add a footer." },
      { role: "assistant", content: "Reading it first.", tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
      { role: "tool", tool_call_id: "t1", content: "export {}" },
      { role: "user", content: "[ASO] 3 turns left." },
    ]);
    assert.ok(!JSON.stringify(messages).includes("private"), "thinking blocks stay with their own model");
  });

  it("marks failed tool results, and shows images only to a model that can see", () => {
    const history = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "no such file" },
          { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "shot.png" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }] },
        ],
      },
    ] as never;
    const blind = toChatMessages("s", history, { vision: false });
    assert.deepEqual(blind[1], { role: "tool", tool_call_id: "t1", content: "Error: no such file" });
    assert.match((blind[2] as { content: string }).content, /^shot\.png\n\[ASO\] The image is not shown/);
    assert.equal(blind.length, 3, "no image message for a model without vision");

    const seeing = toChatMessages("s", history, { vision: true });
    assert.deepEqual(seeing[3], {
      role: "user",
      content: [{ type: "text", text: "The image(s) from the tool result above:" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }],
    });
  });

  it("offers the tools as functions", () => {
    assert.deepEqual(toChatTools([TOOL]), [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: TOOL.input_schema } }]);
  });

  it("adds up a streamed answer, tool-call arguments in pieces included", () => {
    const body = [
      'data: {"model":"qwen3-coder:30b","choices":[{"delta":{"content":"<think>hmm</think>Let me "}}]}',
      'data: {"choices":[{"delta":{"content":"look."}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}',
      ": keep-alive",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":100}}}',
      "data: [DONE]",
    ].join("\n\n");
    const answer = accumulateChunks(sseData(body));
    const res = fromChatAnswer(answer, "qwen3-coder:30b");
    assert.deepEqual(res.content, [
      { type: "text", text: "Let me look.", citations: null },
      { type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.ts" } },
    ]);
    assert.equal(res.stopReason, "tool_use");
    assert.equal(res.model, "qwen3-coder:30b");
    assert.deepEqual(res.tokens, { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 });
  });

  it("maps finish reasons, and refuses tool calls the Hub couldn't run", () => {
    const answer = (finishReason: string) => ({ content: "x", toolCalls: [], finishReason });
    assert.equal(fromChatAnswer(answer("stop"), "m").stopReason, "end_turn");
    assert.equal(fromChatAnswer(answer("length"), "m").stopReason, "max_tokens", "a cut-off answer is handled like Claude's");
    assert.equal(fromChatAnswer(answer("content_filter"), "m").stopReason, "refusal");
    const call = (args: string) => ({ content: "", toolCalls: [{ id: "c", type: "function" as const, function: { name: "read_file", arguments: args } }], finishReason: "tool_calls" });
    assert.deepEqual(fromChatAnswer(call(""), "m").content, [{ type: "tool_use", id: "c", name: "read_file", input: {} }]);
    for (const bad of ["{not json", '"a string"', "[1]"]) {
      assert.throws(() => fromChatAnswer(call(bad), "m"), (e: unknown) => e instanceof LlmError && e.retryable, `retry the turn on ${bad}`);
    }
  });

  it("says which errors to retry, and pauses on an empty account", () => {
    assert.equal(classifyHttp(401, "bad key").retryable, false);
    assert.equal(classifyHttp(404, "model not found").retryable, false);
    assert.equal(classifyHttp(400, "bad").retryable, false);
    assert.equal(classifyHttp(429, "slow down").retryable, true);
    assert.equal(classifyHttp(503, "").retryable, true);
    assert.equal(classifyHttp(429, '{"error":{"code":"insufficient_quota"}}').pause, "credit");
    assert.equal(classifyHttp(402, "credit balance too low").pause, "credit");
  });

  it("is chosen by an openai: model spec, and needs an address", () => {
    assert.equal(openAiCompatibleFor("claude-haiku-5-5", {}, 1000), undefined, "Claude models stay on the Anthropic API");
    assert.throws(() => openAiCompatibleFor("openai:qwen3", {}, 1000), /needs ASO_LLM_BASE_URL/);
    assert.throws(() => openAiCompatibleFor("openai:", { ASO_LLM_BASE_URL: "http://x/v1" }, 1000), /names no model/);
    const a = openAiCompatibleFor("openai:qwen3-coder:30b", { ASO_LLM_BASE_URL: "http://avalon:11434/v1" }, 1000)!;
    assert.equal(a.model, "qwen3-coder:30b");
    assert.equal(a.name, "openai-compatible");
  });
});

/** A tiny OpenAI-compatible server that streams `reply` and records each request. */
async function fakeProvider(reply: (body: Record<string, unknown>) => { status?: number; chunks?: unknown[]; text?: string }) {
  const requests: Array<{ body: Record<string, unknown>; auth?: string; path?: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push({ body, auth: req.headers.authorization, path: req.url });
      const r = reply(body);
      if (r.status && r.status !== 200) return void res.writeHead(r.status).end(r.text ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const c of r.chunks ?? []) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("OpenAI-compatible models: over HTTP", () => {
  it("streams a request with the tools and key, and reads the answer", async () => {
    const provider = await fakeProvider(() => ({
      chunks: [
        { model: "local-model", choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 50, completion_tokens: 5 } },
      ],
    }));
    try {
      const adapter = openAiCompatibleFor("openai:local-model", { ASO_LLM_BASE_URL: `${provider.url}/`, ASO_LLM_API_KEY: "sk-test" }, 2048)!;
      const res = await adapter.complete({ system: "sys", tools: [TOOL], messages: [{ role: "user", content: "go" }] });
      assert.deepEqual(res.content, [{ type: "tool_use", id: "c1", name: "read_file", input: { path: "README.md" } }]);
      assert.equal(res.stopReason, "tool_use");
      const [sent] = provider.requests;
      assert.equal(sent.path, "/v1/chat/completions");
      assert.equal(sent.auth, "Bearer sk-test");
      assert.equal(sent.body.model, "local-model");
      assert.equal(sent.body.stream, true);
      assert.equal(sent.body.max_tokens, 2048);
      assert.equal((sent.body.tools as unknown[]).length, 1);
    } finally {
      await provider.close();
    }
  });

  it("reports HTTP errors and an unreachable server the way the Hub retries them", async () => {
    const provider = await fakeProvider(() => ({ status: 404, text: '{"error":"model \\"nope\\" not found"}' }));
    try {
      const adapter = openAiCompatibleFor("openai:nope", { ASO_LLM_BASE_URL: provider.url }, 100)!;
      await assert.rejects(adapter.complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] }), (e: unknown) => e instanceof LlmError && !e.retryable && /doesn't know this model/.test(e.message));
    } finally {
      await provider.close();
    }
    const gone = openAiCompatibleFor("openai:m", { ASO_LLM_BASE_URL: "http://127.0.0.1:1/v1" }, 100)!;
    await assert.rejects(gone.complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] }), (e: unknown) => e instanceof LlmError && e.retryable && /unreachable/.test(e.message));
  });

  it("lets the Hub run its agents on an OpenAI-compatible model while the Architect stays on Claude", async () => {
    const saved = { url: process.env.ASO_LLM_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    process.env.ASO_LLM_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-used";
    const hub = await startHub({ targetDir: makeTargetRepo(), port: 0, host: "127.0.0.1", token: TOKEN, llm: { model: "claude-opus-5-5", agentModel: "openai:qwen3-coder:30b" } });
    try {
      const llm = (await (await fetch(`http://127.0.0.1:${hub.port}/api/llm`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { model: string; agentModel: string };
      assert.equal(llm.model, "claude-opus-5-5");
      assert.equal(llm.agentModel, "qwen3-coder:30b");
    } finally {
      await hub.close();
      if (saved.url === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
    }
  });
});
