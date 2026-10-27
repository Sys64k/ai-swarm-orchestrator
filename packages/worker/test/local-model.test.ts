import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { callLocalModel, listLocalModels } from "@aso/worker";

/** A local OpenAI-compatible server: lists `qwen` and `llama`, streams "hello" for qwen, 503 for llama. */
async function localServer() {
  const seen: Array<{ url?: string; body?: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
      seen.push({ url: req.url, body });
      if (req.url?.endsWith("/models")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen" }, { id: "llama" }] }));
      if (body?.model === "llama") return void res.writeHead(503).end("busy");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "qwen", choices: [{ delta: { content: "hel" } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("a machine's own model server", () => {
  it("lists its models, and none when it's unreachable", async () => {
    const local = await localServer();
    try {
      assert.deepEqual(await listLocalModels({ url: `${local.url}/`, vision: true }), [{ id: "qwen", vision: true }, { id: "llama", vision: true }]);
    } finally {
      await local.close();
    }
    assert.deepEqual(await listLocalModels({ url: "http://127.0.0.1:1/v1" }), []);
  });

  it("answers the Hub's call with the streamed answer added up, from its own server only", async () => {
    const local = await localServer();
    try {
      const offered = [{ id: "qwen" }, { id: "llama" }];
      const answer = await callLocalModel({ url: local.url }, offered, "qwen", { messages: [{ role: "user", content: "hi" }], max_tokens: 100, model: "ignored" });
      assert.equal(answer.outcome, "ok");
      assert.equal(answer.outcome === "ok" && answer.answer.content, "hello");
      const sent = local.seen.at(-1)!;
      assert.equal(sent.url, "/v1/chat/completions");
      assert.deepEqual([sent.body!.model, sent.body!.stream, sent.body!.max_tokens], ["qwen", true, 100], "the model it was asked for, streamed");

      assert.deepEqual(await callLocalModel({ url: local.url }, offered, "gpt-5", {}), { outcome: "error", error: "this machine doesn't offer the model gpt-5", retryable: false });
      const busy = await callLocalModel({ url: local.url }, offered, "llama", {});
      assert.ok(busy.outcome === "error" && busy.retryable && /HTTP 503/.test(busy.error), "a busy server: try again");
    } finally {
      await local.close();
    }
    const gone = await callLocalModel({ url: "http://127.0.0.1:1/v1" }, [{ id: "qwen" }], "qwen", {});
    assert.ok(gone.outcome === "error" && gone.retryable && /unreachable/.test(gone.error));
  });
});
