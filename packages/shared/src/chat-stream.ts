import { z } from "zod";

/**
 * OpenAI-style Chat Completions streams, read the same way by the Hub (calling an API) and by a
 * worker (calling its own local model for the Hub, see MODEL_CALL).
 */

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider data to send back with the call (Gemini: `{ google: { thought_signature } }`). */
  extra_content?: unknown;
}

/** What a streamed answer adds up to. */
export interface ChatAnswer {
  content: string;
  /** The model's reasoning, where its provider sends it apart from the answer (`reasoning`, `reasoning_content`). */
  reasoning?: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export interface ChatChunk {
  model?: string;
  choices?: Array<{
    delta?: { content?: string | null; reasoning?: string | null; reasoning_content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: unknown }> };
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
    // Ollama and OpenRouter name it `reasoning`; DeepSeek and vLLM `reasoning_content`.
    const reasoning = choice.delta?.reasoning || choice.delta?.reasoning_content;
    if (reasoning) answer.reasoning = (answer.reasoning ?? "") + reasoning;
    for (const [i, d] of (choice.delta?.tool_calls ?? []).entries()) {
      const index = d.index ?? i;
      const call = calls.get(index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      if (d.id) call.id = d.id;
      if (d.function?.name) call.function.name += d.function.name;
      if (d.function?.arguments) call.function.arguments += d.function.arguments;
      if (d.extra_content !== undefined) call.extra_content = d.extra_content;
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

/** A ChatAnswer as sent over the wire (MODEL_ANSWER). */
export const ChatAnswerSchema = z.strictObject({
  content: z.string().max(4_000_000),
  reasoning: z.string().max(4_000_000).optional(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().max(200),
        type: z.literal("function"),
        function: z.object({ name: z.string().max(200), arguments: z.string().max(4_000_000) }),
        extra_content: z.unknown().optional(),
      }),
    )
    .max(200),
  finishReason: z.string().max(100).nullable(),
  model: z.string().max(200).optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
    })
    .optional(),
});
