import { readFile } from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { createLogger, PRESET_INFO, type ProviderPreset, ProviderAddBodySchema, ProviderIdSchema, PROVIDER_PRESETS, type AvailableModel, type ProviderAddBody, type ProviderView } from "@aso/shared";
import { JsonFileWriter } from "../push/json-file.js";
import { AnthropicApiAdapter, type Effort, type LlmAdapter } from "./adapter.js";
import { OPENAI_PREFIX, OpenAiCompatibleAdapter } from "./openai-compatible.js";
import { OpenAiResponsesAdapter } from "./openai-responses.js";
import { registerPrices } from "./pricing.js";

const log = createLogger("providers");

const FILE = "providers.json";
/** How long a provider's model list is reused. */
const LIST_TTL_MS = 5 * 60_000;
/** The Architect's model when none is given and Anthropic is a provider. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
/** Claude models offered when Anthropic's list can't be fetched. */
export const CLAUDE_FALLBACK = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

const StoredSchema = z.object({
  id: ProviderIdSchema,
  preset: z.enum(PROVIDER_PRESETS),
  baseUrl: z.string().url().optional(),
  key: z.string().min(1).optional(),
  vision: z.boolean().optional(),
  label: z.string().max(80).optional(),
});
type Stored = z.infer<typeof StoredSchema>;

/** A provider the Hub can call: one added on the Hub, or one from its environment (.env). */
export interface Provider extends Stored {
  kind: "anthropic" | "openai-compatible";
  source: "added" | "environment";
  label: string;
}

/** What a person gives to add a provider (the API's body). */
export type ProviderInput = ProviderAddBody;

/** How a provider's model list went: how many models, or why it couldn't be fetched. */
export interface ProviderStatus {
  models?: number;
  error?: string;
}

/** Cloud providers' keys the Hub's .env may hold, besides ANTHROPIC_API_KEY. */
export const ENV_KEYS = {
  OPENAI_API_KEY: "openai",
  OPENROUTER_API_KEY: "openrouter",
  GEMINI_API_KEY: "gemini",
  GROQ_API_KEY: "groq",
  MISTRAL_API_KEY: "mistral",
  OLLAMA_API_KEY: "ollama-cloud",
} as const satisfies Record<string, ProviderPreset>;

export interface ProvidersEnv extends Partial<Record<keyof typeof ENV_KEYS, string>> {
  ANTHROPIC_API_KEY?: string;
  ASO_LLM_BASE_URL?: string;
  ASO_LLM_API_KEY?: string;
  ASO_LLM_VISION?: string;
}

/** The providers a Hub's .env describes (the setup before providers could be added). */
export function environmentProviders(env: ProvidersEnv): Provider[] {
  const out: Provider[] = [];
  if (env.ANTHROPIC_API_KEY) out.push({ id: "anthropic", preset: "anthropic", kind: "anthropic", key: env.ANTHROPIC_API_KEY, source: "environment", label: "Anthropic" });
  for (const [name, preset] of Object.entries(ENV_KEYS) as Array<[keyof typeof ENV_KEYS, ProviderPreset]>) {
    const key = env[name]?.trim();
    if (key) out.push(toProvider({ id: preset, preset, key }, "environment"));
  }
  const url = env.ASO_LLM_BASE_URL ? trimUrl(env.ASO_LLM_BASE_URL) : undefined;
  if (url) {
    out.push({
      id: "local",
      preset: "custom",
      kind: "openai-compatible",
      baseUrl: url,
      ...(env.ASO_LLM_API_KEY ? { key: env.ASO_LLM_API_KEY } : {}),
      ...(env.ASO_LLM_VISION === "1" ? { vision: true } : {}),
      source: "environment",
      label: `Local (${new URL(url).host})`,
    });
  }
  return out;
}

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** What's stored for an added provider: its input, tidied. */
function storedOf(input: ProviderInput): Stored {
  return {
    id: input.id ?? input.preset,
    preset: input.preset,
    ...(input.baseUrl ? { baseUrl: trimUrl(input.baseUrl) } : {}),
    ...(input.key ? { key: input.key.trim() } : {}),
    ...(input.vision ? { vision: true } : {}),
  };
}

function toProvider(s: Stored, source: Provider["source"]): Provider {
  const info = PRESET_INFO[s.preset];
  const base = s.baseUrl ?? info.baseUrl ?? undefined;
  const label = s.label ?? (info.local ? `${info.label} (${base ? new URL(base).host : "?"})` : info.label);
  return { ...s, ...(base ? { baseUrl: base } : {}), kind: info.kind, source, label };
}

/** A provider as the API shows it: never the key. */
export function providerView(p: Provider, status?: ProviderStatus): ProviderView {
  return {
    id: p.id,
    preset: p.preset,
    kind: p.kind,
    label: p.label,
    source: p.source,
    hasKey: p.key !== undefined,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.vision ? { vision: true } : {}),
    ...(status?.models !== undefined ? { models: status.models } : {}),
    ...(status?.error ? { error: status.error } : {}),
  };
}

/** A spec split into its provider and model; `explicit`: it named the provider (not a bare `claude-…`). */
export interface ParsedSpec {
  providerId: string;
  model: string;
  spec: string;
  explicit: boolean;
}

/**
 * Splits a model spec into its provider and model: `<provider>/<model>` (the model may contain
 * `/`, as OpenRouter's do); the older forms still work: a bare `claude-…` is Anthropic's, and
 * `openai:<model>` is the .env's OpenAI-compatible server (`local`).
 */
export function parseSpec(spec: string, providers: ReadonlyArray<Pick<Provider, "id">>): ParsedSpec | { error: string } {
  const s = spec.trim();
  const of = (providerId: string, model: string, explicit: boolean): ParsedSpec => ({ providerId, model, spec: `${providerId}/${model}`, explicit });
  if (s.startsWith(OPENAI_PREFIX)) return of("local", s.slice(OPENAI_PREFIX.length), true);
  const slash = s.indexOf("/");
  if (slash > 0 && providers.some((p) => p.id === s.slice(0, slash))) return of(s.slice(0, slash), s.slice(slash + 1), true);
  if (s.startsWith("claude-")) return of("anthropic", s, false);
  return { error: `"${s}" names no provider: write <provider>/<model>, e.g. anthropic/claude-haiku-5-5` };
}

/** Why a spec's provider can't be used, with what to do about it. */
function missingProviderMessage(parsed: ParsedSpec): string {
  if (parsed.providerId === "anthropic") return `${parsed.model} is a Claude model, and the Hub has no Anthropic provider (aso provider add anthropic, or ANTHROPIC_API_KEY)`;
  if (parsed.providerId === "local") {
    return `${parsed.spec} needs ASO_LLM_BASE_URL, the OpenAI-compatible API's root (e.g. http://avalon:11434/v1), or a provider (aso provider add ollama --url …)`;
  }
  return `no provider named ${parsed.providerId}`;
}

const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), pricing: z.object({ prompt: z.unknown(), completion: z.unknown() }).partial().optional() }).loose()),
});

/** An OpenAI-style model list: the ids, and prices when given (OpenRouter: USD per token, as strings). */
export function parseModelList(body: unknown): ModelList {
  const parsed = ModelListSchema.safeParse(body);
  if (!parsed.success) throw new Error("its model list isn't an OpenAI-style one ({ data: [{ id }] })");
  const prices: ModelList["prices"] = {};
  for (const m of parsed.data.data) {
    const input = Number(m.pricing?.prompt);
    const output = Number(m.pricing?.completion);
    // The Hub's price table is per million tokens.
    if (m.pricing && Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) prices[m.id] = { input: input * 1e6, output: output * 1e6 };
  }
  return { ids: parsed.data.data.map((m) => m.id).sort(), prices };
}

export interface ModelList {
  ids: string[];
  prices: Record<string, { input: number; output: number }>;
}

/** The model list a provider's API answers, and any prices it reports. */
export async function fetchModels(p: Provider, fetchFn: typeof fetch = fetch): Promise<ModelList> {
  if (p.kind === "anthropic") {
    const client = new Anthropic({ apiKey: p.key, fetch: fetchFn, maxRetries: 0, timeout: 10_000 });
    const ids: string[] = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    return { ids, prices: {} };
  }
  const res = await fetchFn(`${p.baseUrl}/models`, { headers: p.key ? { authorization: `Bearer ${p.key}` } : {}, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${p.baseUrl} answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (the key was refused)" : ""}`);
  return parseModelList(await res.json());
}

/**
 * The model providers the Hub can call, and the models each offers. A person adds a provider
 * with just its key (known providers know their own address) or a local server's address; the
 * Hub's .env providers (ANTHROPIC_API_KEY, ASO_LLM_BASE_URL) are there too, so a Hub set up the
 * old way keeps working. Added providers live in `<state>/providers.json` (owner-only, with
 * their keys); the API never shows a key. Model lists come from each provider's API, cached.
 */
export class Providers {
  private readonly lists = new Map<string, { at: number; ids: string[]; error?: string }>();
  private readonly writer: JsonFileWriter | undefined;

  private constructor(
    private added: Stored[],
    private readonly env: ProvidersEnv,
    private readonly fetchFn: typeof fetch,
    file?: string,
  ) {
    this.writer = file ? new JsonFileWriter(file, 0o600) : undefined;
  }

  static async open(dir: string | undefined, env: ProvidersEnv, fetchFn: typeof fetch = fetch): Promise<Providers> {
    const file = dir ? path.join(dir, FILE) : undefined;
    let added: Stored[] = [];
    if (file) {
      try {
        added = z.array(StoredSchema).parse(JSON.parse(await readFile(file, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${file} is unreadable, starting with the .env providers only: ${(err as Error).message}`);
      }
    }
    return new Providers(added, env, fetchFn, file);
  }

  /** Every provider: added ones first, then the .env's (an added one with the same id wins). */
  list(): Provider[] {
    const added = this.added.map((s) => toProvider(s, "added"));
    return [...added, ...environmentProviders(this.env).filter((e) => !added.some((a) => a.id === e.id))];
  }

  get(id: string): Provider | undefined {
    return this.list().find((p) => p.id === id);
  }

  /** Every provider as the API shows it (no keys), with how its model list went. */
  async views(): Promise<ProviderView[]> {
    const { status } = await this.models();
    return this.list().map((p) => providerView(p, status.get(p.id)));
  }

  /**
   * Add (or replace) a provider. Its model list is fetched first, so a wrong key or an
   * unreachable server is refused with the reason, and nothing is saved.
   */
  async add(input: ProviderInput): Promise<ProviderView> {
    const valid = ProviderAddBodySchema.safeParse(input);
    if (!valid.success) throw new Error(valid.error.issues.map((i) => i.message).join("; "));
    const stored = storedOf(valid.data);
    const provider = toProvider(stored, "added");
    let listed: ModelList;
    try {
      listed = await fetchModels(provider, this.fetchFn);
    } catch (err) {
      throw new Error(`can't use ${provider.label}: ${(err as Error).message}`);
    }
    const next = [...this.added.filter((a) => a.id !== stored.id), stored];
    await this.writer?.save(next);
    this.added = next;
    this.remember(provider, listed);
    log.info(`provider ${stored.id} (${provider.label}) added: ${listed.ids.length} models`);
    return providerView(provider, { models: listed.ids.length });
  }

  /** Remove an added provider and forget its key; a .env provider can only be removed there. */
  async remove(id: string): Promise<"removed" | "environment" | "missing"> {
    if (!this.added.some((a) => a.id === id)) return this.get(id) ? "environment" : "missing";
    const next = this.added.filter((a) => a.id !== id);
    await this.writer?.save(next);
    this.added = next;
    this.lists.delete(id);
    log.info(`provider ${id} removed`);
    return "removed";
  }

  /** Each provider's models (lists older than 5 minutes fetched again), how each list went, and the failures to show. */
  async models(now = Date.now()): Promise<{ models: AvailableModel[]; status: Map<string, ProviderStatus>; errors: string[] }> {
    const providers = this.list();
    await Promise.all(providers.map((p) => this.refresh(p, now)));
    const models: AvailableModel[] = [];
    const status = new Map<string, ProviderStatus>();
    const errors: string[] = [];
    for (const p of providers) {
      const list = this.lists.get(p.id);
      status.set(p.id, { models: list?.ids.length ?? 0, ...(list?.error ? { error: list.error } : {}) });
      if (list?.error) errors.push(`${p.label}: ${list.error}`);
      for (const id of list?.ids ?? []) {
        models.push({ model: id, spec: `${p.id}/${id}`, provider: p.kind, providerId: p.id, providerLabel: p.label, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}) });
      }
    }
    return { models, status, errors };
  }

  /** Fetch a provider's list unless the cached one is fresh; on failure, Anthropic still offers the known Claude models. */
  private async refresh(p: Provider, now: number): Promise<void> {
    const cached = this.lists.get(p.id);
    if (cached && now - cached.at < LIST_TTL_MS) return;
    try {
      this.remember(p, await fetchModels(p, this.fetchFn), now);
    } catch (err) {
      this.lists.set(p.id, { at: now, ids: p.kind === "anthropic" ? CLAUDE_FALLBACK : [], error: (err as Error).message });
    }
  }

  private remember(p: Provider, listed: ModelList, now = Date.now()): void {
    registerPrices(listed.prices);
    this.lists.set(p.id, { at: now, ids: listed.ids });
  }

  /** A spec's provider and model, or why it can't be used. */
  private resolve(spec: string): { provider: Provider; parsed: ParsedSpec } | { error: string } {
    const providers = this.list();
    const parsed = parseSpec(spec, providers);
    if ("error" in parsed) return parsed;
    const provider = providers.find((x) => x.id === parsed.providerId);
    return provider ? { provider, parsed } : { error: missingProviderMessage(parsed) };
  }

  /** The Architect's model when none is given: Claude Opus when Anthropic is a provider; otherwise none, and the person chooses. */
  defaultModel(): string | undefined {
    return this.get("anthropic") ? DEFAULT_CLAUDE_MODEL : undefined;
  }

  /** The model name a spec or name refers to (prices are per model name). */
  modelName(typed: string): string {
    const parsed = parseSpec(typed, this.list());
    return "error" in parsed ? typed.trim() : parsed.model;
  }

  /** Whether a spec's model runs on a local server (Ollama, a custom address, the .env's): one GPU, one call at once. */
  isLocal(spec: string): boolean {
    const r = this.resolve(spec);
    return !("error" in r) && PRESET_INFO[r.provider.preset].local;
  }

  /** The adapter for a model spec; throws when its provider is missing. A desk's settings override the provider's address and vision. */
  adapterFor(spec: string, opts: { maxTokens: number; effort: Effort; vision?: boolean; baseUrl?: string }): LlmAdapter {
    const r = this.resolve(spec);
    if ("error" in r) throw new Error(r.error);
    const { provider: p, parsed } = r;
    if (p.kind === "anthropic") return new AnthropicApiAdapter({ model: parsed.model, effort: opts.effort, maxTokens: opts.maxTokens, apiKey: p.key });
    const baseUrl = opts.baseUrl ?? p.baseUrl;
    if (!baseUrl) throw new Error(`${p.label} has no address`);
    // OpenAI's own newer models take tools with reasoning only on its Responses API; the other
    // OpenAI-compatible providers speak Chat Completions.
    if (p.preset === "openai") {
      return new OpenAiResponsesAdapter({ baseUrl, model: parsed.model, apiKey: p.key, provider: p.label, maxTokens: opts.maxTokens, vision: opts.vision ?? p.vision ?? false });
    }
    return new OpenAiCompatibleAdapter({
      baseUrl,
      model: parsed.model,
      apiKey: p.key,
      provider: p.label,
      maxTokens: opts.maxTokens,
      maxTokensField: PRESET_INFO[p.preset].maxTokensField,
      vision: opts.vision ?? p.vision ?? false,
    });
  }
}

/**
 * The spec for what a person typed: a spec as listed (`anthropic/claude-haiku-5-5`), a model's
 * name when one provider offers it (`qwen3-coder:30b`), or an older form (`claude-…`,
 * `openai:…`). Otherwise an error naming the closest matches, or the providers to choose from.
 */
export function resolveModel(input: string, available: AvailableModel[], providers: ReadonlyArray<Pick<Provider, "id">>): { spec: string } | { error: string } {
  const typed = input.trim();
  const bySpec = available.find((m) => m.spec === typed);
  if (bySpec) return { spec: bySpec.spec };
  const byName = available.filter((m) => m.model === typed);
  if (byName.length === 1) return { spec: byName[0].spec };
  if (byName.length > 1) return { error: `several providers offer "${typed}": choose one of ${byName.map((m) => `"${m.spec}"`).join(", ")}` };
  // A spec naming a known provider is taken as is (a model its list doesn't show yet).
  const parsed = parseSpec(typed, providers);
  if (!("error" in parsed) && parsed.explicit && providers.some((p) => p.id === parsed.providerId)) return { spec: parsed.spec };
  const close = closest(typed, available.map((m) => m.model));
  const hint = close.length ? ` Did you mean ${close.map((m) => `"${m}"`).join(" or ")}?` : "";
  const none = available.length ? "" : " The Hub has no providers: add one with `aso provider add`.";
  return { error: `no model "${typed}".${hint}${none}` };
}

/** Names that contain what was typed (or the reverse), else those within a few edits of it. */
function closest(typed: string, names: string[]): string[] {
  const t = typed.toLowerCase();
  const unique = [...new Set(names)];
  const containing = unique.filter((n) => n.toLowerCase().includes(t) || t.includes(n.toLowerCase()));
  if (containing.length) return containing.slice(0, 3);
  return unique
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
