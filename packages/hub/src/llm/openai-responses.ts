import type Anthropic from "@anthropic-ai/sdk";
import { sseData } from "@aso/shared";
import { LlmError, type LlmAdapter, type LlmRequest, type LlmResponse } from "./adapter.js";
import { flattenToolResult, parseToolArguments, postForStream, providerLabel, TOOL_IMAGES_INTRO, type OpenAiBaseOptions } from "./openai-http.js";

/**
 * OpenAI's own models through its Responses API. Its newer models take tools together with
 * reasoning only there, not on Chat Completions (which the other OpenAI-compatible providers keep).
 * Like the Chat Completions adapter, it translates the Hub's Messages-format conversation per
 * request. Nothing is stored at OpenAI (`store: false`); a model's reasoning isn't carried from one
 * turn to the next, only its answers and tool calls.
 */

export type OpenAiResponsesOptions = OpenAiBaseOptions;

type InputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };

export type ResponsesInputItem =
  | { role: "user"; content: string | InputContent[] }
  | { role: "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface ResponsesTool {
  type: "function";
  name: string;
  description?: string;
  parameters: unknown;
}

type OutputItem =
  | { type: "message"; content: Array<{ type: "output_text"; text: string } | { type: "refusal"; refusal: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "reasoning" };

/** A finished response, as the stream's last event carries it. */
export interface ResponsesAnswer {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  error?: { message?: string } | null;
  output: OutputItem[];
  usage?: { input_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens?: number };
}

export function toResponsesTools(tools: Anthropic.Beta.BetaTool[]): ResponsesTool[] {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema }));
}

/**
 * The conversation as Responses input items. Tool calls and their results pair by `call_id`; an
 * image a tool returned follows as a user message (a call's output is text), or as a note when
 * the model has no vision. Thinking blocks are dropped: they only mean something to their own model.
 */
export function toResponsesInput(messages: Anthropic.Beta.BetaMessageParam[], opts: { vision: boolean }): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(message.role === "user" ? { role: "user", content: message.content } : { role: "assistant", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (text) out.push({ role: "assistant", content: text });
      for (const b of message.content) {
        if (b.type === "tool_use") out.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    const images: InputContent[] = [];
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const { text, imageUrls } = flattenToolResult(block, opts.vision);
        images.push(...imageUrls.map((image_url): InputContent => ({ type: "input_image", image_url })));
        out.push({ type: "function_call_output", call_id: block.tool_use_id, output: text });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    if (images.length) out.push({ role: "user", content: [{ type: "input_text", text: TOOL_IMAGES_INTRO }, ...images] });
    if (texts.length) out.push({ role: "user", content: texts.join("\n\n") });
  }
  return out;
}

/** A Hub request as a Responses request body (without the streaming field). */
export function responsesRequest(req: LlmRequest, opts: { model: string; maxTokens: number; vision: boolean }): Record<string, unknown> {
  return {
    model: opts.model,
    instructions: req.system,
    input: toResponsesInput(req.messages, { vision: opts.vision }),
    tools: toResponsesTools(req.tools),
    max_output_tokens: opts.maxTokens,
    store: false,
  };
}

/** Why a response stopped, as the Hub says it (the Messages API's stop reasons). */
function stopReasonOf(answer: ResponsesAnswer, calledTools: boolean, refused: boolean): string {
  if (calledTools) return "tool_use";
  if (refused) return "refusal";
  if (answer.status === "incomplete") return answer.incomplete_details?.reason === "content_filter" ? "refusal" : "max_tokens";
  return "end_turn";
}

/** The answer in the Hub's format. Rejects tool calls whose arguments aren't a JSON object. */
export function fromResponsesAnswer(answer: ResponsesAnswer, requestedModel: string): LlmResponse {
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  const texts: string[] = [];
  let refused = false;
  for (const item of answer.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "output_text") texts.push(part.text);
      else if (part.type === "refusal") {
        refused = true;
        texts.push(part.refusal);
      }
    }
  }
  const text = texts.join("\n").trim();
  if (text) content.push({ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock);
  const calls = answer.output.filter((i): i is Extract<OutputItem, { type: "function_call" }> => i.type === "function_call");
  for (const call of calls) {
    const input = parseToolArguments(call.name, call.arguments);
    content.push({ type: "tool_use", id: call.call_id, name: call.name, input } as Anthropic.Beta.BetaToolUseBlock);
  }
  const cached = answer.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    content,
    stopReason: stopReasonOf(answer, calls.length > 0, refused),
    refusalCategory: null,
    model: answer.model ?? requestedModel,
    tokens: {
      inputTokens: Math.max(0, (answer.usage?.input_tokens ?? 0) - cached),
      outputTokens: answer.usage?.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  };
}

/** The finished response in a streamed body: the last `response.completed`, `.incomplete` or `.failed` event's. */
export function finalResponse(body: string): ResponsesAnswer {
  let final: ResponsesAnswer | undefined;
  for (const event of sseData(body) as Iterable<unknown>) {
    const e = event as { type?: string; response?: ResponsesAnswer; message?: string };
    if (e.type === "error") throw new LlmError(`the model provider failed: ${e.message ?? "an error event"}`, true);
    if (e.response && (e.type === "response.completed" || e.type === "response.incomplete" || e.type === "response.failed")) final = e.response;
  }
  if (!final) throw new LlmError("the model provider's answer ended before the response was complete", true);
  if (final.status === "failed") throw new LlmError(`the model provider failed: ${final.error?.message ?? "no reason given"}`, true);
  return final;
}

export class OpenAiResponsesAdapter implements LlmAdapter {
  readonly name = "openai-responses";
  readonly model: string;
  readonly provider: string;

  constructor(private readonly opts: OpenAiResponsesOptions) {
    this.model = opts.model;
    this.provider = providerLabel(opts);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = await postForStream(this.opts, "responses", {
      ...responsesRequest(req, { model: this.model, maxTokens: this.opts.maxTokens, vision: this.opts.vision ?? false }),
      stream: true,
    });
    return fromResponsesAnswer(finalResponse(body), this.model);
  }
}
