import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { finalResponse, fromResponsesAnswer, OpenAiResponsesAdapter, responsesRequest, toResponsesInput, type ResponsesAnswer } from "@aso/hub";

const sse = (...events: unknown[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const completed = (response: Partial<ResponsesAnswer>) => ({ type: "response.completed", response: { status: "completed", output: [], ...response } });

describe("OpenAI's Responses API", () => {
  it("sends the conversation as input items: calls and their results by call_id, images after them", () => {
    const input = toResponsesInput(
      [
        { role: "user", content: "Fix the bug." },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "s" },
            { type: "text", text: "Looking." },
            { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "code" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
            { type: "tool_result", tool_use_id: "call_2", content: "nope", is_error: true },
          ],
        },
      ],
      { vision: true },
    );
    assert.deepEqual(input, [
      { role: "user", content: "Fix the bug." },
      { role: "assistant", content: "Looking." },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
      { type: "function_call_output", call_id: "call_1", output: "code" },
      { type: "function_call_output", call_id: "call_2", output: "Error: nope" },
      { role: "user", content: [{ type: "input_text", text: "The image(s) from the tool result above:" }, { type: "input_image", image_url: "data:image/png;base64,AAA" }] },
    ]);
    const blind = toResponsesInput([{ role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] }] }], { vision: false });
    assert.match((blind[0] as { output: string }).output, /The image is not shown/);
  });

  it("asks with the system prompt as instructions, function tools, an output limit, and nothing stored", () => {
    const body = responsesRequest(
      { system: "Be careful.", tools: [{ name: "ready", description: "Say so.", input_schema: { type: "object", properties: {} } }], messages: [{ role: "user", content: "x" }] },
      { model: "gpt-6.1-sol", maxTokens: 2000, vision: false },
    );
    assert.deepEqual(body, {
      model: "gpt-6.1-sol",
      instructions: "Be careful.",
      input: [{ role: "user", content: "x" }],
      tools: [{ type: "function", name: "ready", description: "Say so.", parameters: { type: "object", properties: {} } }],
      max_output_tokens: 2000,
      store: false,
    });
  });

  it("reads the answer: text, tool calls, why it stopped, and the cached input apart", () => {
    const r = fromResponsesAnswer(
      {
        model: "gpt-6.1-sol-2026-09-01",
        status: "completed",
        output: [
          { type: "reasoning" },
          { type: "message", content: [{ type: "output_text", text: "Reporting." }] },
          { type: "function_call", call_id: "call_9", name: "report_acceptance", arguments: '{"summary":"ok"}' },
        ],
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50 },
      },
      "gpt-6.1-sol",
    );
    assert.deepEqual(r.content.map((b) => b.type), ["text", "tool_use"]);
    assert.deepEqual(r.content[1], { type: "tool_use", id: "call_9", name: "report_acceptance", input: { summary: "ok" } });
    assert.deepEqual([r.stopReason, r.model, r.tokens], ["tool_use", "gpt-6.1-sol-2026-09-01", { inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 }]);

    assert.equal(fromResponsesAnswer({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] }, "m").stopReason, "max_tokens");
    assert.equal(fromResponsesAnswer({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] }, "m").stopReason, "refusal");
    assert.equal(fromResponsesAnswer({ status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't." }] }] }, "m").stopReason, "refusal");
    assert.throws(() => fromResponsesAnswer({ output: [{ type: "function_call", call_id: "c", name: "x", arguments: "[1]" }] }, "m"), /aren't a JSON object/);
  });

  it("takes the finished response from the stream, and says when there is none or it failed", () => {
    const body = sse({ type: "response.created", response: { status: "in_progress", output: [] } }, { type: "response.output_text.delta", delta: "Hi" }, completed({ output: [] }));
    assert.equal(finalResponse(body).status, "completed");
    assert.throws(() => finalResponse(sse({ type: "response.created", response: { status: "in_progress", output: [] } })), /ended before the response was complete/);
    assert.throws(() => finalResponse(sse({ type: "response.failed", response: { status: "failed", error: { message: "server_error" }, output: [] } })), /failed: server_error/);
    assert.throws(() => finalResponse(sse({ type: "error", message: "overloaded" })), /overloaded/);
  });

  it("calls POST <base>/responses with the key, and turns an HTTP error into the Hub's", async () => {
    const seen: Array<{ url?: string; auth?: string; body: Record<string, unknown> }> = [];
    let status = 200;
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      if (status !== 200) return void res.writeHead(status, { "content-type": "application/json" }).end('{"error":{"message":"Unsupported parameter"}}');
      res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(completed({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] })));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const adapter = new OpenAiResponsesAdapter({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/`, model: "gpt-6.1-sol", apiKey: "sk-x", maxTokens: 100 });
      const r = await adapter.complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] });
      assert.deepEqual([seen[0].url, seen[0].auth, seen[0].body.stream], ["/v1/responses", "Bearer sk-x", true]);
      assert.equal((r.content[0] as { text: string }).text, "ok");
      status = 400;
      await assert.rejects(adapter.complete({ system: "s", tools: [], messages: [{ role: "user", content: "x" }] }), /bad request \(400\).*Unsupported parameter/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
