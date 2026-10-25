import type Anthropic from "@anthropic-ai/sdk";
import { LlmError, type LlmAdapter, type LlmRequest, type LlmResponse } from "./adapter.js";

/**
 * Any model behind an OpenAI-compatible Chat Completions API: OpenAI, Gemini, Mistral, Groq,
 * OpenRouter, LiteLLM, and local servers such as Ollama, vLLM and LM Studio. The Hub keeps its
 * conversations in one format (the Messages API's, which it already speaks); this adapter
 * translates each request to Chat Completions and the answer back.
 */

/** The model-spec prefix that selects this adapter: `--agent-model openai:qwen3-coder:30b`. */
export const OPENAI_PREFIX = "openai:";

export interface OpenAiCompatibleOptions {
  /** API root, e.g. `http://avalon:11434/v1` or `https://api.openai.com/v1`. */
  baseUrl: string;
  model: string;
  /** Sent as a Bearer token; local servers usually need none. */
  apiKey?: string;
  maxTokens: number;
  /** Whether the model accepts images; without it, view_image results reach it as text only. */
  vision?: boolean;
  /** How long one answer may take. Local models on a CPU can be slow. */
  timeoutMs?: number;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
}

interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
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

/** What a streamed answer adds up to. */
export interface ChatAnswer {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

const IMAGE_OMITTED = "[ASO] The image is not shown: this model is not set up to accept images.";

export function toChatTools(tools: Anthropic.Beta.BetaTool[]): ChatTool[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

function textOf(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
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
      const calls = message.content.flatMap((b): ChatToolCall[] =>
        b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : [],
      );
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const images: ChatContentPart[] = [];
    const texts: string[] = [];
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const parts = typeof block.content === "string" || !block.content ? [] : block.content;
        let text = textOf(block.content as string | Array<{ type: string; text?: string }> | undefined);
        for (const part of parts) {
          if (part.type !== "image" || part.source.type !== "base64") continue;
          if (opts.vision) images.push({ type: "image_url", image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } });
          else text = `${text}\n${IMAGE_OMITTED}`;
        }
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.is_error ? `Error: ${text}` : text });
      } else if (block.type === "text") {
        texts.push(block.text);
      }
    }
    if (images.length) out.push({ role: "user", content: [{ type: "text", text: "The image(s) from the tool result above:" }, ...images] });
    if (texts.length) out.push({ role: "user", content: texts.join("\n\n") });
  }
  return out;
}

const STOP_REASONS: Record<string, string> = { stop: "end_turn", tool_calls: "tool_use", function_call: "tool_use", length: "max_tokens", content_filter: "refusal" };

/** The answer in the Hub's format. Rejects tool calls whose arguments aren't a JSON object. */
export function fromChatAnswer(answer: ChatAnswer, requestedModel: string): LlmResponse {
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  // Some open models write their reasoning inline; it isn't part of the answer.
  const text = answer.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (text) content.push({ type: "text", text, citations: null } as Anthropic.Beta.BetaTextBlock);
  for (const call of answer.toolCalls) {
    let input: unknown;
    try {
      input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    } catch {
      throw new LlmError(`the model's call to ${call.function.name} has arguments that aren't valid JSON`, true);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new LlmError(`the model's call to ${call.function.name} has arguments that aren't a JSON object`, true);
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input } as Anthropic.Beta.BetaToolUseBlock);
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

interface ChatChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
  usage?: ChatAnswer["usage"];
}

/** Add up a streamed answer's chunks (the `data:` payloads of its server-sent events). */
export function accumulateChunks(chunks: Iterable<ChatChunk>): ChatAnswer {
  const answer: ChatAnswer = { content: "", toolCalls: [], finishReason: null };
  const calls = new Map<number, ChatToolCall>();
  for (const chunk of chunks) {
    if (chunk.model) answer.model = chunk.model;
    if (chunk.usage) answer.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.delta?.content) answer.content += choice.delta.content;
    for (const [i, d] of (choice.delta?.tool_calls ?? []).entries()) {
      const index = d.index ?? i;
      const call = calls.get(index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (d.id) call.id = d.id;
      if (d.function?.name) call.function.name += d.function.name;
      if (d.function?.arguments) call.function.arguments += d.function.arguments;
      calls.set(index, call);
    }
    if (choice.finish_reason) answer.finishReason = choice.finish_reason;
  }
  answer.toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }));
  return answer;
}

/** The JSON payloads in a server-sent-events body, up to `[DONE]`. */
export function* sseData(body: string): Generator<ChatChunk> {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      yield JSON.parse(data) as ChatChunk;
    } catch {
      // A keep-alive or a provider's comment: not part of the answer.
    }
  }
}

/** An HTTP error as the Hub handles it: what to say, and whether trying again can help. */
export function classifyHttp(status: number, body: string): LlmError {
  const text = body.slice(0, 500).trim() || `HTTP ${status}`;
  if (/insufficient_quota|exceeded your current quota|credit/i.test(body) && (status === 402 || status === 429)) {
    return new LlmError(`the model provider says the account is out of credit or quota: ${text}`, true, "credit");
  }
  if (status === 401 || status === 403) return new LlmError(`the model provider rejected the credentials: ${text}`, false);
  if (status === 404) return new LlmError(`the model provider doesn't know this model or endpoint: ${text}`, false);
  if (status === 408 || status === 429) return new LlmError(`rate limited or busy: ${text}`, true);
  if (status >= 500) return new LlmError(`the model provider is unavailable (${status}): ${text}`, true);
  return new LlmError(`bad request (${status}): ${text}`, false);
}

export class OpenAiCompatibleAdapter implements LlmAdapter {
  readonly name = "openai-compatible";
  readonly model: string;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.model = opts.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    let body: string;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.model,
          messages: toChatMessages(req.system, req.messages, { vision: this.opts.vision ?? false }),
          tools: toChatTools(req.tools),
          max_tokens: this.opts.maxTokens,
          // Streamed, so a slow answer keeps the connection alive past HTTP timeouts.
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30 * 60_000),
      });
      body = await res.text();
    } catch (err) {
      const reason = (err as Error).name === "TimeoutError" ? "no complete answer in time" : (err as Error).message;
      throw new LlmError(`the model provider at ${this.opts.baseUrl} is unreachable: ${reason}`, true);
    }
    if (!res.ok) throw classifyHttp(res.status, body);
    return fromChatAnswer(accumulateChunks(sseData(body)), this.model);
  }
}

/** Settings for OpenAI-compatible models, from the Hub's environment. */
export interface OpenAiCompatibleEnv {
  ASO_LLM_BASE_URL?: string;
  ASO_LLM_API_KEY?: string;
  /** `1`: the model accepts images (view_image). */
  ASO_LLM_VISION?: string;
}

/**
 * The adapter for an `openai:<model>` spec, or undefined for any other spec (a Claude model).
 * Throws when the spec asks for an OpenAI-compatible model but no base URL is set.
 */
export function openAiCompatibleFor(spec: string, env: OpenAiCompatibleEnv, maxTokens: number): OpenAiCompatibleAdapter | undefined {
  if (!spec.startsWith(OPENAI_PREFIX)) return undefined;
  const model = spec.slice(OPENAI_PREFIX.length);
  if (!model) throw new Error(`"${spec}" names no model: use openai:<model>, e.g. openai:qwen3-coder:30b`);
  const baseUrl = env.ASO_LLM_BASE_URL?.trim();
  if (!baseUrl) throw new Error(`${spec} needs ASO_LLM_BASE_URL, the OpenAI-compatible API's root (e.g. http://avalon:11434/v1 for Ollama)`);
  return new OpenAiCompatibleAdapter({ baseUrl, model, apiKey: env.ASO_LLM_API_KEY || undefined, maxTokens, vision: env.ASO_LLM_VISION === "1" });
}
