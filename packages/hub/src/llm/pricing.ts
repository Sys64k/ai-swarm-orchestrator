import type { LlmUsage, PriceEntry } from "@aso/shared";

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

/** Prices providers report themselves (OpenRouter's), per million tokens; they apply after the built-in ones. */
const reported = new Map<string, Price>();
/** Prices set on the Hub (`aso price set`); they win over the others. */
const custom = new Map<string, Price>();

/** A price as set on the Hub: per million tokens; cache rates default to the input price. */
export interface SetPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Replace the prices set on the Hub. */
export function setCustomPrices(prices: Record<string, SetPrice>): void {
  custom.clear();
  for (const [model, p] of Object.entries(prices)) custom.set(model, { input: p.input, output: p.output, cacheWrite: p.cacheWrite ?? p.input, cacheRead: p.cacheRead ?? p.input });
}

/** The built-in prices and those set on the Hub (a set one replaces a built-in one); not every reported one. */
export function priceTable(): PriceEntry[] {
  const entry = (model: string, p: Price, source: PriceEntry["source"]): PriceEntry => ({ model, input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite, source });
  const builtIn = Object.entries(PRICES).filter(([m]) => !custom.has(m)).map(([model, p]) => entry(model, p, "built-in"));
  const set = [...custom].map(([model, p]) => entry(model, p, "set"));
  return [...builtIn, ...set].sort((a, b) => a.model.localeCompare(b.model));
}

/** Record prices a provider reported (input and output per million tokens; no cache rates). */
export function registerPrices(prices: Record<string, { input: number; output: number }>): void {
  for (const [model, p] of Object.entries(prices)) reported.set(model, { input: p.input, output: p.output, cacheWrite: p.input, cacheRead: p.input });
}

function priceOf(model: string): Price | undefined {
  return custom.get(model) ?? PRICES[model] ?? reported.get(model);
}

export function hasPrice(model: string): boolean {
  return priceOf(model) !== undefined;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Estimated cost; unknown models count as 0 (the Hub warns at startup). */
export function priceUsage(model: string, t: TokenCounts): LlmUsage {
  const p = priceOf(model);
  const costUsd = p
    ? (t.inputTokens * p.input + t.outputTokens * p.output + t.cacheWriteTokens * p.cacheWrite + t.cacheReadTokens * p.cacheRead) / 1e6
    : 0;
  return { ...t, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}
