import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger, DeskSchema, ModelProfileBodySchema, ModelProfileNameSchema, type Models } from "@aso/shared";
import { JsonFileWriter } from "../push/json-file.js";
import { AnthropicApiAdapter, type Effort, type LlmAdapter } from "./adapter.js";
import { OPENAI_PREFIX, openAiCompatibleFor, type OpenAiCompatibleEnv } from "./openai-compatible.js";
import { Semaphore } from "./semaphore.js";

const log = createLogger("models");

const FILE = "models.json";

export type ModelProfileDef = z.infer<typeof ModelProfileBodySchema>;

const ModelsFileSchema = z.object({
  profiles: z.record(ModelProfileNameSchema, ModelProfileBodySchema).default({}),
  desks: z.record(DeskSchema, ModelProfileNameSchema).default({}),
});

/** A desk's name: its machine's hostname and job slot. */
export function deskName(host: string, slot: number): string {
  return `${host}#${slot}`;
}

/** Calls a profile may make at once: its own setting, else 1 for a local-style API, else the Hub's default. */
export function profileConcurrency(def: ModelProfileDef, hubDefault: number): number {
  return def.concurrency ?? (def.model.startsWith(OPENAI_PREFIX) ? 1 : hubDefault);
}

/** Builds the adapter for a profile; throws when it can't (e.g. an openai: model without an address). */
export type AdapterFactory = (def: ModelProfileDef) => LlmAdapter;

/**
 * The adapter for a profile: an OpenAI-compatible API for `openai:` models (the profile's base
 * URL and vision override the Hub's ASO_LLM_* settings), else the Anthropic API, which needs
 * ANTHROPIC_API_KEY in `env`.
 */
export function adapterForProfile(def: ModelProfileDef, opts: { env: OpenAiCompatibleEnv & { ANTHROPIC_API_KEY?: string }; maxTokens: number; effort: Effort }): LlmAdapter {
  const env: OpenAiCompatibleEnv = {
    ...opts.env,
    ...(def.baseUrl ? { ASO_LLM_BASE_URL: def.baseUrl } : {}),
    ...(def.vision === undefined ? {} : { ASO_LLM_VISION: def.vision ? "1" : "0" }),
  };
  const openAi = openAiCompatibleFor(def.model, env, opts.maxTokens);
  if (openAi) return openAi;
  if (!opts.env.ANTHROPIC_API_KEY) throw new Error(`${def.model} is a Claude model, and the Hub has no ANTHROPIC_API_KEY`);
  return new AnthropicApiAdapter({ model: def.model, effort: opts.effort, maxTokens: opts.maxTokens, apiKey: opts.env.ANTHROPIC_API_KEY });
}

/** A model to call, with its limit on calls at once. */
export interface Route {
  adapter: LlmAdapter;
  slots: Semaphore;
}

/**
 * Model profiles, and which desks use them. A profile is a model with its own address and its
 * own limit on calls at once, so a local model's GPU never gets more requests than it can serve
 * while Claude desks run at full speed. Desks without a profile, and the Architect, keep the
 * Hub's `--agent-model` and `--model`. Saved in `<state>/models.json` (owner-only); the file
 * holds no secrets (keys come from the Hub's environment).
 */
export class ModelProfiles {
  private readonly routes = new Map<string, Route>();
  private readonly writer: JsonFileWriter | undefined;

  private constructor(
    private profiles: Record<string, ModelProfileDef>,
    private desks: Record<string, string>,
    private readonly factory: AdapterFactory,
    private readonly hubConcurrency: number,
    file?: string,
  ) {
    this.writer = file ? new JsonFileWriter(file, 0o600) : undefined;
  }

  private makeRoute(def: ModelProfileDef, adapter = this.factory(def)): Route {
    return { adapter, slots: new Semaphore(profileConcurrency(def, this.hubConcurrency)) };
  }

  static async open(dir: string | undefined, factory: AdapterFactory, hubConcurrency: number): Promise<ModelProfiles> {
    const file = dir ? path.join(dir, FILE) : undefined;
    let data: z.infer<typeof ModelsFileSchema> = { profiles: {}, desks: {} };
    if (file) {
      try {
        data = ModelsFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${file} is unreadable, starting without model profiles: ${(err as Error).message}`);
      }
    }
    // A desk whose profile is gone falls back to the default rather than failing.
    const desks = Object.fromEntries(Object.entries(data.desks).filter(([, p]) => data.profiles[p]));
    return new ModelProfiles(data.profiles, desks, factory, hubConcurrency, file);
  }

  /** The profile a desk uses, or undefined for the default agent model. */
  profileOf(desk: string): string | undefined {
    return this.desks[desk];
  }

  /** Whether a profile with this name exists. */
  has(name: string): boolean {
    return Object.hasOwn(this.profiles, name);
  }

  /** The adapter and call limit of a profile; built on first use. Undefined if the profile is gone. */
  route(name: string): Route | undefined {
    const def = this.profiles[name];
    if (!def) return undefined;
    let route = this.routes.get(name);
    if (!route) {
      route = this.makeRoute(def);
      this.routes.set(name, route);
    }
    return route;
  }

  /** Add or replace a profile. Its adapter is built now, so a bad one is refused before it's saved. */
  async setProfile(name: string, def: ModelProfileDef): Promise<void> {
    const route = this.makeRoute(def);
    await this.commit({ ...this.profiles, [name]: def }, this.desks);
    // New calls use the new definition; calls already running finish on the old one.
    this.routes.set(name, route);
    log.info(`model profile ${name}: ${def.model}`);
  }

  /** Remove a profile; desks that used it go back to the default. False when there was none. */
  async removeProfile(name: string): Promise<boolean> {
    if (!this.has(name)) return false;
    const { [name]: _gone, ...rest } = this.profiles;
    await this.commit(rest, Object.fromEntries(Object.entries(this.desks).filter(([, p]) => p !== name)));
    this.routes.delete(name);
    log.info(`model profile ${name} removed`);
    return true;
  }

  /** Give a desk a profile, or null for the default. Throws for an unknown profile. */
  async assign(desk: string, profile: string | null): Promise<void> {
    if (profile !== null && !this.has(profile)) throw new Error(`no model profile named ${profile}`);
    const { [desk]: _old, ...rest } = this.desks;
    await this.commit(this.profiles, profile === null ? rest : { ...rest, [desk]: profile });
    log.info(`desk ${desk}: ${profile ?? "default agent model"}`);
  }

  /** The profiles, by name, with their limits and how busy they are now. */
  list(): Models["profiles"] {
    return Object.entries(this.profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, def]) => {
        const status = this.routes.get(name)?.slots.status();
        return { ...def, name, concurrency: profileConcurrency(def, this.hubConcurrency), running: status?.running ?? 0, waiting: status?.waiting ?? 0 };
      });
  }

  /** The desks that have a profile. */
  deskList(): Models["desks"] {
    return Object.entries(this.desks)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([desk, profile]) => ({ desk, profile }));
  }

  /** What `GET /api/models` answers. */
  view(architect: string | null, defaultAgent: string | null): Models {
    return { architect, defaultAgent, profiles: this.list(), desks: this.deskList() };
  }

  /** Save the new state, then use it: a failed save (thrown, so the API says so) changes nothing. */
  private async commit(profiles: Record<string, ModelProfileDef>, desks: Record<string, string>): Promise<void> {
    await this.writer?.save({ profiles, desks });
    this.profiles = profiles;
    this.desks = desks;
  }
}
