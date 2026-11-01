import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import {
  accumulateChunks,
  classifyHttp,
  fromChatAnswer,
  LlmError,
  OpenAiCompatibleAdapter,
  splitThoughts,
  sseData,
  thoughtsRequest,
  startHub,
  toChatMessages,
  toChatTools,
  withoutProviderData,
} from "@aso/hub";
import { makeTargetRepo, TOKEN } from "./helpers.ts";

const TOOL = { name: "read_file", description: "Read a file", input_schema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] } };

describe("OpenAI-compatible models: translation", () => {
  it("leaves out an assistant turn with nothing in it: Ollama refuses content null without tool calls", () => {
    const messages = toChatMessages(
      "s",
      [
        { role: "user", content: "Go." },
        { role: "assistant", content: [{ type: "thinking", thinking: "only thinking", signature: "" }] },
        { role: "user", content: "You ended your turn without calling finish." },
      ],
      { vision: false },
    );
    assert.deepEqual(messages.map((m) => m.role), ["system", "user", "user"]);
  });

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

  it("keeps the model's reasoning apart from its answer: inline, or in its own field", () => {
    const res = fromChatAnswer(accumulateChunks(sseData('data: {"choices":[{"delta":{"content":"<think>hmm</think>Let me look."}}]}')), "m");
    assert.equal(res.reasoning, "hmm");
    // Gemini's thought summary, when asked for.
    assert.deepEqual(splitThoughts("<thought>**Checking**\n391 = 17 × 23.\n</thought>No"), { text: "No", thoughts: ["**Checking**\n391 = 17 × 23."] });
    assert.deepEqual(splitThoughts("Done.<think>cut off while thin"), { text: "Done.", thoughts: ["cut off while thin"] }, "an answer cut off while thinking");
    assert.deepEqual(splitThoughts("no reasoning"), { text: "no reasoning", thoughts: [] });
    const fields = accumulateChunks([
      { choices: [{ delta: { reasoning: "Ollama " } }] },
      { choices: [{ delta: { reasoning_content: "and vLLM" } }] },
      { choices: [{ delta: { content: "Answer" } }] },
    ]);
    assert.equal(fields.reasoning, "Ollama and vLLM");
    assert.deepEqual(fromChatAnswer(fields, "m").content, [{ type: "text", text: "Answer", citations: null }], "never part of the answer");
    assert.equal("reasoning" in fromChatAnswer(accumulateChunks([{ choices: [{ delta: { content: "x" } }] }]), "m"), false);
  });

  it("asks Gemini, and only Gemini, for its thought summary", () => {
    assert.deepEqual(thoughtsRequest("https://generativelanguage.googleapis.com/v1beta/openai"), { extra_body: { google: { thinking_config: { include_thoughts: true } } } });
    assert.deepEqual(thoughtsRequest("https://api.openai.com/v1"), {});
    assert.deepEqual(thoughtsRequest("http://avalon:11434/v1"), {});
  });

  it("keeps a tool call's provider data and sends it back next turn, but never to Anthropic (Gemini's thought signature)", () => {
    const signature = { google: { thought_signature: "sig-abc" } };
    const answer = accumulateChunks([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: '{"path":"a"}' }, extra_content: signature }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "read_file", arguments: '{"path":"b"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const content = fromChatAnswer(answer, "m").content;
    assert.deepEqual((content[0] as unknown as Record<string, unknown>).aso_provider_data, signature);
    assert.ok(!("aso_provider_data" in content[1]), "only the call that had some");

    const conversation = [
      { role: "user" as const, content: "go" },
      { role: "assistant" as const, content },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "c1", content: "A" }, { type: "tool_result" as const, tool_use_id: "c2", content: "B" }] },
    ];
    const sent = toChatMessages("sys", conversation, { vision: false });
    const calls = (sent[2] as { tool_calls: Array<{ id: string; extra_content?: unknown }> }).tool_calls;
    assert.deepEqual(calls.map((c) => [c.id, c.extra_content ?? null]), [["c1", signature], ["c2", null]]);

    const forAnthropic = withoutProviderData(conversation);
    assert.ok(!JSON.stringify(forAnthropic).includes("aso_provider_data"), "Anthropic's API would refuse the unknown field");
    assert.equal(forAnthropic[0], conversation[0], "messages without it are passed as they are");
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
      const adapter = new OpenAiCompatibleAdapter({ baseUrl: `${provider.url}/`, model: "local-model", apiKey: "sk-test", maxTokens: 2048 });
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

      // OpenAI's reasoning models refuse max_tokens: its provider sends the newer field.
      const openAi = new OpenAiCompatibleAdapter({ baseUrl: provider.url, model: "local-model", maxTokens: 4096, maxTokensField: "max_completion_tokens" });
      await openAi.complete({ system: "sys", tools: [TOOL], messages: [{ role: "user", content: "go" }] });
      const last = provider.requests.at(-1)!.body;
      assert.deepEqual([last.max_completion_tokens, "max_tokens" in last], [4096, false]);
    } finally {
      await provider.close();
    }
  });

  it("reports HTTP errors and an unreachable server the way the Hub retries them", async () => {
    const provider = await fakeProvider(() => ({ status: 404, text: '{"error":"model \\"nope\\" not found"}' }));
    try {
      const adapter = new OpenAiCompatibleAdapter({ baseUrl: provider.url, model: "nope", maxTokens: 100 });
      await assert.rejects(adapter.complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] }), (e: unknown) => e instanceof LlmError && !e.retryable && /doesn't know this model/.test(e.message));
    } finally {
      await provider.close();
    }
    const gone = new OpenAiCompatibleAdapter({ baseUrl: "http://127.0.0.1:1/v1", model: "m", maxTokens: 100 });
    await assert.rejects(
      gone.complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] }),
      (e: unknown) => e instanceof LlmError && e.retryable && e.pause === "unreachable" && /unreachable/.test(e.message),
      "a server that can't be reached holds its provider's calls once it stays so",
    );
    const slow = new OpenAiCompatibleAdapter({ baseUrl: "http://127.0.0.1:1/v1", model: "m", maxTokens: 100, fetch: async () => Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })) });
    await assert.rejects(
      slow.complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] }),
      (e: unknown) => e instanceof LlmError && e.retryable && e.pause === undefined && /no complete answer in time/.test(e.message),
      "a server that answers too slowly was reached: only retried",
    );
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
