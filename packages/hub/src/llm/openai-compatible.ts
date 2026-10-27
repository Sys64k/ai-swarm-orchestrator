import type Anthropic from "@anthropic-ai/sdk";
import type { LlmAdapter, LlmRequest, LlmResponse } from "./adapter.js";
import { classifyHttp, flattenToolResult, parseToolArguments, postForStream, TOOL_IMAGES_INTRO, type OpenAiBaseOptions } from "./openai-http.js";
import { PROVIDER_DATA } from "./provider-data.js";
import { accumulateChunks, sseData, type ChatAnswer, type ChatToolCall } from "@aso/shared";

export { accumulateChunks, classifyHttp, sseData, type ChatAnswer };

/**
 * Any model behind an OpenAI-compatible Chat Completions API: OpenAI, Gemini, Mistral, Groq,
 * OpenRouter, LiteLLM, and local servers such as Ollama, vLLM and LM Studio. The Hub keeps its
 * conversations in one format (the Messages API's, which it already speaks); this adapter
 * translates each request to Chat Completions and the answer back.
 */

/** The model-spec prefix that selects this adapter: `--agent-model openai:qwen3-coder:30b`. */
export const OPENAI_PREFIX = "openai:";

export interface OpenAiCompatibleOptions extends OpenAiBaseOptions {
  /** The request field for `maxTokens` (default `max_tokens`; OpenAI's reasoning models need `max_completion_tokens`). */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}


type ChatContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ChatContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}


export function toChatTools(tools: Anthropic.Beta.BetaTool[]): ChatTool[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

/**
 * The conversation as Chat Completions messages. Tool results become `tool` messages; an image a
 * tool returned follows as a user message (tool messages can't carry images), or as a note when
 * the model has no vision. Thinking blocks are dropped: they only mean something to their own model.
 */
export function toChatMessages(system: string, messages: Anthropic.Beta.BetaMessageParam[], opts: { vision: boolean }): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(message.role === "user" ? { role: "user", content: message.content } : { role: "assistant", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      const calls = message.content.flatMap((b): ChatToolCall[] => {
        if (b.type !== "tool_use") return [];
        const extra = (b as typeof b & { [PROVIDER_DATA]?: unknown })[PROVIDER_DATA];
        return [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, ...(extra === undefined ? {} : { extra_content: extra }) }];
      });
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const images: ChatContentPart[] = [];
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const { text, imageUrls } = flattenToolResult(block, opts.vision);
        images.push(...imageUrls.map((url): ChatContentPart => ({ type: "image_url", image_url: { url } })));
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    if (images.length) out.push({ role: "user", content: [{ type: "text", text: TOOL_IMAGES_INTRO }, ...images] });
    if (texts.length) out.push({ role: "user", content: texts.join("\n\n") });
  }
  return out;
}

/** A Hub request as a Chat Completions request body (without the streaming fields). */
export function chatRequest(
  req: LlmRequest,
  opts: { model: string; maxTokens: number; maxTokensField?: "max_tokens" | "max_completion_tokens"; vision: boolean },
): Record<string, unknown> {
  return {
    model: opts.model,
    messages: toChatMessages(req.system, req.messages, { vision: opts.vision }),
    tools: toChatTools(req.tools),
    [opts.maxTokensField ?? "max_tokens"]: opts.maxTokens,
  };
}

const STOP_REASONS: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

/** The answer in the Hub's format. Rejects tool calls whose arguments aren't a JSON object. */
export function fromChatAnswer(answer: ChatAnswer, requestedModel: string): LlmResponse {
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  // Some open models write their reasoning inline; it isn't part of the answer.
  const text = answer.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (text) content.push({ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock);
  for (const call of answer.toolCalls) {
    const input = parseToolArguments(call.function.name, call.function.arguments);
    // Kept with the call, so the next turn sends it back (Gemini refuses a call without its thought signature).
    const extra = call.extra_content === undefined ? {} : { [PROVIDER_DATA]: call.extra_content };
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input, ...extra } as Anthropic.Beta.BetaToolUseBlock);
  }
  const finish = answer.toolCalls.length ? "tool_calls" : (answer.finishReason ?? "stop");
  const cached = answer.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    content,
    stopReason: STOP_REASONS[finish] ?? finish,
    refusalCategory: null,
    model: answer.model ?? requestedModel,
    tokens: {
      inputTokens: Math.max(0, (answer.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: answer.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  };
}


export class OpenAiCompatibleAdapter implements LlmAdapter {
  readonly name = "openai-compatible";
  readonly model: string;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.model = opts.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const body = await postForStream(this.opts, "chat/completions", {
      ...chatRequest(req, { model: this.model, maxTokens: this.opts.maxTokens, maxTokensField: this.opts.maxTokensField, vision: this.opts.vision ?? false }),
      stream: true,
      stream_options: { include_usage: true },
    });
    return fromChatAnswer(accumulateChunks(sseData(body)), this.model);
  }
}
