import Anthropic from "@anthropic-ai/sdk";
import type { TokenCounts } from "./pricing.js";
import { withoutProviderData } from "./provider-data.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface LlmRequest {
  system: string;
  tools: Anthropic.Beta.BetaTool[];
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface LlmResponse {
  /** Full assistant content, kept verbatim in the conversation (thinking blocks included). */
  content: Anthropic.Beta.BetaContentBlock[];
  stopReason: string | null;
  /** Category when stopReason is "refusal". */
  refusalCategory?: string | null;
  /** Model that produced the final answer (differs from the requested one after a fallback). */
  model: string;
  tokens: TokenCounts;
  /** What the model thought before answering, when its provider returns it: trimmed and never empty, shown, never sent back. */
  reasoning?: string;
}

export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    message: string,
    readonly retryable: boolean,
    /**
     * Why its provider's calls should wait until one works again: `credit`, the account ran out
     * of credit or hit a usage limit (at once); `unreachable`, the provider can't be reached
     * (after a grace period, see `shouldHold`: a short blip is only retried).
     */
    readonly pause?: "credit" | "unreachable",
    /** When the provider says access comes back (an ISO time), if it says. */
    readonly until?: string,
  ) {
    super(message);
  }
}

export const CREDIT_MESSAGE =
  "Anthropic credit balance is too low: add credits at console.anthropic.com (Settings → Billing). Work waits and resumes by itself";

/** Anthropic's spend limit (console.anthropic.com → Settings → Limits): reached, calls fail until it resets or is raised. */
const USAGE_LIMIT = /reached your specified API usage limits/i;

/** "You will regain access on 2026-11-01 at 00:00 UTC" as an ISO time; undefined when the text names none. */
export function resetTime(text: string): string | undefined {
  const m = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) UTC/i.exec(text);
  return m ? `${m[1]}T${m[2]}:00.000Z` : undefined;
}

export function usageLimitMessage(until: string | undefined): string {
  return `Anthropic API usage limit reached${until ? ` until ${until.slice(0, 16).replace("T", " ")} UTC` : ""}: raise it at console.anthropic.com (Settings → Limits). Work on Anthropic models waits and resumes by itself`;
}

/** The API's own words: a streamed error arrives as its raw JSON body. */
export function apiErrorText(message: string): string {
  try {
    const body = JSON.parse(message) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") return body.error.message;
  } catch {
    // Not JSON: already plain text.
  }
  return message;
}

/** Per-answer output cap (thinking included); the agents' instructions name it. */
export const DEFAULT_MAX_TOKENS = 32_000;

/** A model provider. The Hub is the only component that talks to one. */
export interface LlmAdapter {
  readonly name: string;
  readonly model: string;
  /** The account its calls go to ("Anthropic", a provider's label): an out-of-credit pause holds that account's calls only. */
  readonly provider?: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Whose account an adapter's calls use: its provider, else its kind. */
export function providerOf(adapter: LlmAdapter): string {
  return adapter.provider ?? adapter.name;
}

/** Models that accept `fallbacks: "default"` (server-side retry on another model after a refusal). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface AnthropicAdapterOptions {
  model: string;
  effort: Effort;
  /** Per-turn output cap. Requests stream, so large values don't hit HTTP timeouts. */
  maxTokens: number;
  /** Defaults to ANTHROPIC_API_KEY / other SDK credential sources. */
  apiKey?: string;
  /** Injected client (tests). */
  client?: Pick<Anthropic, "beta">;
}

/**
 * Claude models that think by default (adaptive), so asking for a readable summary of it changes
 * nothing but what comes back: their thinking text is otherwise empty. Older models would start
 * thinking (and cost more) if asked, so they're left as they are.
 */
export function summarizesThinking(model: string): boolean {
  return /^claude-[a-z]+-5(?:-\d+)?$/.test(model);
}

/** Pieces of reasoning as one text (`LlmResponse.reasoning`): trimmed, empty ones left out, undefined when none is left. */
export function joinReasoning(parts: ReadonlyArray<string | undefined>): string | undefined {
  return parts.map((p) => p?.trim()).filter(Boolean).join("\n\n") || undefined;
}

/** The readable thinking in an answer's thinking blocks, if any. */
export function thinkingText(content: readonly Anthropic.Beta.BetaContentBlock[]): string | undefined {
  return joinReasoning(content.map((b) => (b.type === "thinking" ? b.thinking : undefined)));
}

/** Official Anthropic API via @anthropic-ai/sdk. */
export class AnthropicApiAdapter implements LlmAdapter {
  readonly name = "anthropic-api";
  readonly provider = "Anthropic";
  readonly model: string;
  private readonly client: Pick<Anthropic, "beta">;

  constructor(private readonly opts: AnthropicAdapterOptions) {
    this.model = opts.model;
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const fallbacks = FALLBACK_MODELS.has(this.model);
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: this.opts.maxTokens,
        system: req.system,
        tools: req.tools,
        messages: withoutProviderData(req.messages),
        // Caches the growing conversation prefix: each turn re-reads earlier turns at the cache rate.
        cache_control: { type: "ephemeral" },
        output_config: { effort: this.opts.effort },
        ...(summarizesThinking(this.model) ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
        ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      message = await stream.finalMessage();
    } catch (err) {
      throw classify(err);
    }
    const u = message.usage;
    return {
      content: message.content,
      stopReason: message.stop_reason,
      refusalCategory: message.stop_details?.category ?? null,
      model: message.model,
      reasoning: thinkingText(message.content),
      tokens: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

export function classify(err: unknown): LlmError {
  if (err instanceof Anthropic.APIError && /credit balance is too low/i.test(err.message)) return new LlmError(CREDIT_MESSAGE, true, "credit");
  if (err instanceof Anthropic.APIError && USAGE_LIMIT.test(err.message)) {
    const until = resetTime(err.message);
    return new LlmError(usageLimitMessage(until), true, "credit", until);
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError(`Anthropic API rejected the credentials: ${err.message}`, false);
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError(`rate limited: ${err.message}`, true);
  if (err instanceof Anthropic.BadRequestError) return new LlmError(`bad request: ${err.message}`, false);
  // A timeout reached the API but got no answer in time; any other connection error didn't reach it.
  if (err instanceof Anthropic.APIConnectionError && !(err instanceof Anthropic.APIConnectionTimeoutError)) {
    return new LlmError(`Anthropic API unreachable: ${err.message}`, true, "unreachable");
  }
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new LlmError(`Anthropic API unavailable: ${err.message}`, true);
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(`API error${err.status ? ` ${err.status}` : ""}: ${apiErrorText(err.message)}`, (err.status ?? 0) >= 500);
  }
  // Not an API error: e.g. an eagerly streamed tool input that could not be parsed. Re-issuing the turn helps.
  return new LlmError(`model response could not be processed: ${(err as Error).message}`, true);
}
