import type { AvailableModel } from "@aso/shared";
import { OPENAI_PREFIX } from "./openai-compatible.js";
import { hasPrice } from "./pricing.js";

/** The Claude models the Hub knows (and prices). */
export const CLAUDE_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

/** How long a fetched list of local models is reused. */
const LIST_TTL_MS = 30_000;

export interface CatalogEnv {
  ANTHROPIC_API_KEY?: string;
  ASO_LLM_BASE_URL?: string;
  ASO_LLM_API_KEY?: string;
}

/**
 * The models desks can use: the Claude models when the Hub has an Anthropic key, and whatever
 * the OpenAI-compatible API at ASO_LLM_BASE_URL lists (`GET /models`: Ollama, vLLM, LM Studio,
 * OpenRouter and OpenAI all answer it).
 */
export class ModelCatalog {
  private cached?: { at: number; local: AvailableModel[]; error?: string };

  constructor(
    private readonly env: CatalogEnv,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async list(now = Date.now()): Promise<{ models: AvailableModel[]; localError?: string }> {
    const claude: AvailableModel[] = this.env.ANTHROPIC_API_KEY ? CLAUDE_MODELS.map((m) => ({ model: m, spec: m, provider: "anthropic" as const })) : [];
    if (!this.cached || now - this.cached.at >= LIST_TTL_MS) this.cached = { at: now, ...(await this.fetchLocal()) };
    return { models: [...claude, ...this.cached.local], ...(this.cached.error ? { localError: this.cached.error } : {}) };
  }

  private async fetchLocal(): Promise<{ local: AvailableModel[]; error?: string }> {
    const baseUrl = this.env.ASO_LLM_BASE_URL?.trim().replace(/\/+$/, "");
    if (!baseUrl) return { local: [] };
    try {
      const res = await this.fetchFn(`${baseUrl}/models`, {
        headers: this.env.ASO_LLM_API_KEY ? { authorization: `Bearer ${this.env.ASO_LLM_API_KEY}` } : {},
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { local: [], error: `${baseUrl} answered HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const ids = (body.data ?? []).flatMap((m) => (typeof m.id === "string" && m.id ? [m.id] : []));
      return { local: ids.sort().map((id) => ({ model: id, spec: `${OPENAI_PREFIX}${id}`, provider: "openai-compatible" as const, baseUrl })) };
    } catch (err) {
      return { local: [], error: `${baseUrl} can't be reached: ${(err as Error).message}` };
    }
  }
}

/**
 * The model spec for what a person typed: an exact name from the list (`qwen3-coder:30b`,
 * `claude-haiku-5-5`), or an explicit `openai:<name>`, which is taken as is (e.g. a model on
 * another server, with its own --base-url). Otherwise an error naming the closest matches.
 */
export function resolveModel(input: string, available: AvailableModel[]): { spec: string } | { error: string } {
  const typed = input.trim();
  if (typed.startsWith(OPENAI_PREFIX) && typed.length > OPENAI_PREFIX.length) return { spec: typed };
  const exact = available.find((m) => m.model === typed || m.spec === typed);
  if (exact) return { spec: exact.spec };
  // A Claude model the Hub prices but doesn't list as current is still a valid choice.
  if (typed.startsWith("claude-") && hasPrice(typed) && available.some((m) => m.provider === "anthropic")) return { spec: typed };
  const close = closest(typed, available.map((m) => m.model));
  const hint = close.length ? ` Did you mean ${close.map((m) => `"${m}"`).join(" or ")}?` : "";
  const known = available.length ? ` Available: ${available.map((m) => m.model).join(", ")}.` : " The Hub knows no models: set ANTHROPIC_API_KEY or ASO_LLM_BASE_URL.";
  return { error: `no model "${typed}".${hint}${known}` };
}

/** Names that contain what was typed (or the reverse), else those within a few edits of it. */
function closest(typed: string, names: string[]): string[] {
  const t = typed.toLowerCase();
  const containing = names.filter((n) => n.toLowerCase().includes(t) || t.includes(n.toLowerCase()));
  if (containing.length) return containing.slice(0, 3);
  return names
    .map((n) => ({ n, d: editDistance(t, n.toLowerCase()) }))
    .filter(({ d }) => d <= 3)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ n }) => n);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
