import type Anthropic from "@anthropic-ai/sdk";
import { LlmError } from "./adapter.js";

/**
 * What the two OpenAI-style adapters (Chat Completions and OpenAI's Responses API) share: the
 * options, the streamed POST and its errors, a tool result in plain parts, and a tool call's
 * arguments. Their wire formats stay in their own files.
 */

export interface OpenAiBaseOptions {
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

/**
 * POST a streamed request to `<baseUrl>/<path>` and return the whole streamed body. Streaming
 * keeps a slow answer's connection alive past HTTP timeouts. Throws the Hub's `LlmError`.
 */
export async function postForStream(opts: OpenAiBaseOptions, path: string, body: Record<string, unknown>): Promise<string> {
  let res: Response;
  let text: string;
  try {
    res = await (opts.fetch ?? fetch)(`${opts.baseUrl.replace(/\/+$/, "")}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30 * 60_000),
    });
    text = await res.text();
  } catch (err) {
    const reason = (err as Error).name === "TimeoutError" ? "no complete answer in time" : (err as Error).message;
    throw new LlmError(`the model provider at ${opts.baseUrl} is unreachable: ${reason}`, true);
  }
  if (!res.ok) throw classifyHttp(res.status, text);
  return text;
}

/** A tool call's arguments as an object; a retryable error when they aren't one (the turn is asked again). */
export function parseToolArguments(name: string, raw: string): Record<string, unknown> {
  let input: unknown;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new LlmError(`the model's call to ${name} has arguments that aren't valid JSON`, true);
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LlmError(`the model's call to ${name} has arguments that aren't a JSON object`, true);
  }
  return input as Record<string, unknown>;
}

/** Said in place of an image to a model that doesn't take images. */
export const IMAGE_OMITTED = "[ASO] The image is not shown: this model is not set up to accept images.";
/** Said before the images that follow a tool's result as their own message. */
export const TOOL_IMAGES_INTRO = "The image(s) from the tool result above:";

function textOf(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
}

/**
 * A tool result in plain parts: its text (`Error:` first when it failed) and its images as data
 * URLs, or, for a model without vision, a note in the text instead of each image.
 */
export function flattenToolResult(block: Anthropic.Beta.BetaToolResultBlockParam, vision: boolean): { text: string; imageUrls: string[] } {
  const parts = typeof block.content === "string" || !block.content ? [] : block.content;
  let text = textOf(block.content as string | Array<{ type: string; text?: string }> | undefined);
  const imageUrls: string[] = [];
  for (const part of parts) {
    if (part.type !== "image" || part.source.type !== "base64") continue;
    if (vision) imageUrls.push(`data:${part.source.media_type};base64,${part.source.data}`);
    else text = `${text}\n${IMAGE_OMITTED}`;
  }
  return { text: block.is_error ? `Error: ${text}` : text, imageUrls };
}
