import type { LlmUsage } from "@aso/shared";

/** USD per million tokens. Standard first-party API rates as of 2026-10; verify against the pricing page. */
interface Price {
  input: number;
  output: number;
  /** 5-minute cache write. */
  cacheWrite: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export function hasPrice(model: string): boolean {
  return Object.hasOwn(PRICES, model);
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Estimated cost; unknown models count as 0 (the Hub warns at startup). */
export function priceUsage(model: string, t: TokenCounts): LlmUsage {
  const p = PRICES[model];
  const costUsd = p
    ? (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheWriteTokens * p.cacheWrite + t.cacheReadTokens * p.cacheRead) / 1e6
    : 0;
  return { ...t, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}
