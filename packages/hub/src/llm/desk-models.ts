import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger, DeskSchema, DeskModelSettingsSchema, type Desks } from "@aso/shared";
import { JsonFileWriter } from "../push/json-file.js";
import type { LlmAdapter } from "./adapter.js";
import { Semaphore } from "./semaphore.js";

const log = createLogger("models");

const FILE = "models.json";

/** Optional settings for one model; everything has a default. */
export type ModelSettings = z.infer<typeof DeskModelSettingsSchema>;

/** A model as the Hub calls it: a Claude id, or `openai:<name>` for an OpenAI-compatible API. */
export type ModelSpec = string;

const ModelsFileSchema = z.object({
  models: z.record(z.string().min(1), DeskModelSettingsSchema).default({}),
  desks: z.record(DeskSchema, z.string().min(1)).default({}),
});

/** A desk's name: its machine's hostname and job slot. */
export function deskName(host: string, slot: number): string {
  return `${host}#${slot}`;
}

/** Calls a model may make at once: its own setting, else 1 on a local server (one GPU), else the Hub's default. */
export function modelConcurrency(settings: ModelSettings, local: boolean, hubDefault: number): number {
  return settings.concurrency ?? (local ? 1 : hubDefault);
}

/** Whether a spec's model runs on a local server (the providers know). */
export type IsLocal = (spec: ModelSpec) => boolean;

/** Builds the adapter for a model; throws when it can't (e.g. an openai: model without an address). */
export type AdapterFactory = (spec: ModelSpec, settings: ModelSettings) => LlmAdapter;

/** A model to call, with its limit on calls at once. */
export interface Route {
  adapter: LlmAdapter;
  slots: Semaphore;
}

/**
 * Which model each desk's agents use. A desk names a model; a model may have its own settings
 * (calls at once, address), and gets its own adapter and call limit, so a local model's GPU
 * never gets more requests than it can serve while Claude desks run at full speed. Desks
 * without a model, and the Architect, keep the Hub's `--agent-model` and `--model`. Saved in
 * `<state>/models.json` (owner-only); the file holds no secrets (keys come from the Hub's
 * environment).
 */
export class DeskModels {
  private readonly routes = new Map<ModelSpec, Route>();
  private readonly writer: JsonFileWriter | undefined;

  private constructor(
    private settings: Record<ModelSpec, ModelSettings>,
    private desks: Record<string, ModelSpec>,
    private readonly factory: AdapterFactory,
    private readonly hubConcurrency: number,
    private readonly isLocal: IsLocal,
    file?: string,
  ) {
    this.writer = file ? new JsonFileWriter(file, 0o600) : undefined;
  }

  static async open(dir: string | undefined, factory: AdapterFactory, hubConcurrency: number, isLocal: IsLocal): Promise<DeskModels> {
    const file = dir ? path.join(dir, FILE) : undefined;
    let data: z.infer<typeof ModelsFileSchema> = { models: {}, desks: {} };
    if (file) {
      try {
        data = ModelsFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${file} is unreadable, starting with every desk on the default model: ${(err as Error).message}`);
      }
    }
    return new DeskModels(data.models, data.desks, factory, hubConcurrency, isLocal, file);
  }

  /** The model a desk uses, or undefined for the default agent model. */
  modelOf(desk: string): ModelSpec | undefined {
    return this.desks[desk];
  }

  /** The adapter and call limit of a model; built on first use. Throws when the Hub can't use it. */
  route(spec: ModelSpec): Route {
    let route = this.routes.get(spec);
    if (!route) {
      route = this.makeRoute(spec, this.settings[spec] ?? {});
      this.routes.set(spec, route);
    }
    return route;
  }

  /**
   * Put desks on a model (or back on the default with `null`). New settings for the model replace
   * its old ones. The adapter is built first, so a model the Hub can't use is refused, and a
   * failed save changes nothing.
   */
  async assign(desks: string[], spec: ModelSpec | null, settings?: ModelSettings): Promise<void> {
    const next = { ...this.desks };
    for (const desk of desks) {
      if (spec === null) delete next[desk];
      else next[desk] = spec;
    }
    let nextSettings = this.settings;
    let route: Route | undefined;
    if (spec !== null) {
      const merged = settings ?? this.settings[spec] ?? {};
      route = this.makeRoute(spec, merged);
      nextSettings = { ...this.settings, [spec]: merged };
    }
    // Settings of models no desk uses any more are dropped, so the file only holds what's in use.
    const used = new Set(Object.values(next));
    nextSettings = Object.fromEntries(Object.entries(nextSettings).filter(([s]) => used.has(s)));
    await this.writer?.save({ models: nextSettings, desks: next });
    this.desks = next;
    this.settings = nextSettings;
    // New calls use the new settings; calls already running finish on the old ones.
    if (spec !== null && route) this.routes.set(spec, route);
    log.info(`desk${desks.length === 1 ? "" : "s"} ${desks.join(", ")}: ${spec ?? "default agent model"}`);
  }

  /** What `GET /api/desks` answers: each desk with a model, and each model in use with its load. */
  view(architect: string | null, defaultAgent: string | null): Desks {
    const desks = Object.entries(this.desks)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([desk, model]) => ({ desk, model }));
    const models = [...new Set(Object.values(this.desks))].sort().map((spec) => {
      const settings = this.settings[spec] ?? {};
      const status = this.routes.get(spec)?.slots.status();
      return {
        model: spec,
        ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
        concurrency: modelConcurrency(settings, this.isLocal(spec), this.hubConcurrency),
        running: status?.running ?? 0,
        waiting: status?.waiting ?? 0,
      };
    });
    return { architect, defaultAgent, desks, models };
  }

  private makeRoute(spec: ModelSpec, settings: ModelSettings): Route {
    return { adapter: this.factory(spec, settings), slots: new Semaphore(modelConcurrency(settings, this.isLocal(spec), this.hubConcurrency)) };
  }
}

/**
 * The desks a target names: `avalon#4` is that desk; `avalon` is every desk of the connected
 * machine with that hostname (its slot count). Error text when the machine isn't connected.
 */
export function desksOf(target: string, workers: ReadonlyArray<{ hostname: string; slots: number }>): string[] | { error: string } {
  if (target.includes("#")) return [target];
  const machine = workers.find((w) => w.hostname === target);
  if (!machine) {
    const known = [...new Set(workers.map((w) => w.hostname))];
    return { error: `${target} isn't connected${known.length ? ` (connected: ${known.join(", ")})` : ""}; name a desk instead, e.g. ${target}#1` };
  }
  return Array.from({ length: machine.slots }, (_, i) => deskName(target, i + 1));
}
