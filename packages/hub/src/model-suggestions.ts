import type { AvailableModel, ModelSuggestion, ModelSuggestions, SuggestionEvidence, SuggestionRole, TrackRecords } from "@aso/shared";
import { deskName } from "./llm/desk-models.js";

/**
 * Model suggestions: which model each role (the desks, the reviewer, the Architect) would do as
 * well on for less, or clearly better on, judged from the track records by model. Pure; it only
 * suggests, a person (or `aso desk`) applies.
 */

type Row = TrackRecords["rows"][number];

/**
 * Per role: the data a model needs before it's compared (`minSamples`), how much worse its
 * quality may be and still count as as good (`qualityMargin`), and the words for its figures.
 */
export const ROLE_RULES: Record<SuggestionRole, { minSamples: number; qualityMargin: number; quality: string; unit: string; samples: string }> = {
  desks: { minSamples: 10, qualityMargin: 0.1, quality: "finished", unit: "finished task", samples: "settled tasks" },
  reviewer: { minSamples: 10, qualityMargin: 0.05, quality: "held up", unit: "check", samples: "met verdicts" },
  architect: { minSamples: 5, qualityMargin: 0.1, quality: "approved", unit: "plan", samples: "proposed plans" },
};
/** How much cheaper a model must be to be suggested for the cost alone. */
export const COST_MARGIN = 0.15;
/** How long a period suggestions compare unless asked otherwise. */
export const DEFAULT_PERIOD_DAYS = 30;

/** The start of the default period, from `now` (ms). */
export function defaultSince(now = Date.now()): string {
  return new Date(now - DEFAULT_PERIOD_DAYS * 86_400_000).toISOString();
}

/** A role's record of a model, or undefined when the model has done nothing in it. */
function evidenceOf(row: Row, role: SuggestionRole): SuggestionEvidence | undefined {
  switch (role) {
    case "desks": {
      const s = row.started;
      if (!s.settled || s.costPerFinishedUsd === undefined) return undefined;
      return { model: row.key, samples: s.settled, quality: s.finished / s.settled, unitCostUsd: s.costPerFinishedUsd };
    }
    case "reviewer": {
      const r = row.reviews;
      if (!r.met) return undefined;
      return { model: row.key, samples: r.met, quality: 1 - r.overturned / r.met, unitCostUsd: r.costUsd / r.checks };
    }
    case "architect": {
      const p = row.plans;
      if (!p.proposed) return undefined;
      return { model: row.key, samples: p.proposed, quality: p.approved / p.proposed, unitCostUsd: p.costUsd / p.planned };
    }
  }
}

/** Each model's record in a role, from track records by model (models with none left out). */
export function roleEvidence(byModel: TrackRecords, role: SuggestionRole): SuggestionEvidence[] {
  return byModel.rows.flatMap((row) => {
    const e = evidenceOf(row, role);
    return e ? [e] : [];
  });
}

const pct = (q: number) => `${Math.round(q * 100)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** A model's figures in words: "$1.29 a finished task, 90% finished (20 settled tasks)". */
function described(e: SuggestionEvidence, role: SuggestionRole): string {
  const r = ROLE_RULES[role];
  return `${usd(e.unitCostUsd)} a ${r.unit}, ${pct(e.quality)} ${r.quality} (${e.samples} ${r.samples})`;
}

/**
 * The suggestion for one role, or a note on why there is none. `current` is the model the role is
 * on now (by name); candidates are the other models with enough data.
 */
export function suggestFor(
  role: SuggestionRole,
  rows: readonly Row[],
  current: string | undefined,
): { suggestion?: Omit<ModelSuggestion, "spec" | "apply">; note?: string } {
  // Without one, the desks have no machine connected (right after a Hub restart, say); a role, no model.
  if (!current) return { note: role === "desks" ? "No worker machine is connected right now, so no desk's model to compare." : "No model is set for it." };
  const all = rows.map((r) => evidenceOf(r, role)).filter((e): e is SuggestionEvidence => e !== undefined);
  const { minSamples: min, samples, qualityMargin: margin } = ROLE_RULES[role];
  const now = all.find((e) => e.model === current);
  if (!now || now.samples < min) return { note: `${current}: ${now?.samples ?? 0} of ${min} ${samples} needed to compare it.` };
  const others = all.filter((e) => e.model !== current && e.samples >= min);
  if (!others.length) {
    // The desks and the reviewer can get one that data with a trial.
    const trial = role === "architect" ? "" : ` Put one on trial to get it: aso challenger ${role} <model>.`;
    return { note: `No other model has ${min} ${samples} yet to compare ${current} with.${trial}` };
  }

  const cheaper = others
    .filter((e) => e.unitCostUsd <= now.unitCostUsd * (1 - COST_MARGIN) && e.quality >= now.quality - margin)
    .sort((a, b) => a.unitCostUsd - b.unitCostUsd)[0];
  if (cheaper) {
    const saved = 1 - cheaper.unitCostUsd / now.unitCostUsd;
    return {
      suggestion: {
        role,
        kind: "cheaper",
        current: now,
        suggested: cheaper,
        reason: `${cheaper.model} costs ${pct(saved)} less for about the same: ${described(cheaper, role)}, against ${described(now, role)}.`,
      },
    };
  }
  // Clearly better: twice the margin, so noise doesn't flip it back and forth.
  const better = others.filter((e) => e.quality >= now.quality + 2 * margin).sort((a, b) => b.quality - a.quality || a.unitCostUsd - b.unitCostUsd)[0];
  if (better) {
    return {
      suggestion: { role, kind: "better", current: now, suggested: better, reason: `${better.model} does clearly better: ${described(better, role)}, against ${described(now, role)}.` },
    };
  }
  return { note: `${current} is the best choice among the models with enough data.` };
}

/** A model's name as track records show it, from a spec (`gemini/models/x` → `models/x`) or a name. */
export function modelName(specOrName: string, available: readonly Pick<AvailableModel, "model" | "spec">[]): string {
  const offered = available.find((a) => a.spec === specOrName);
  if (offered) return offered.model;
  return specOrName.startsWith("anthropic/") ? specOrName.slice("anthropic/".length) : specOrName;
}

/** The model most connected desks use now: their own, else the default agent model. Undefined without connected desks. */
export function currentDeskModel(desks: readonly string[], ownModelOf: (desk: string) => string | undefined, defaultAgent: string | null): string | undefined {
  const counts = new Map<string, number>();
  for (const desk of desks) {
    const model = ownModelOf(desk) ?? defaultAgent;
    if (model) counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** The connected machines, by hostname and job slots, as the Hub's registry knows them. */
export interface ConnectedMachine {
  hostname: string;
  slots: number;
}

/**
 * What each role is on now, from the Hub's view: the desks' model is the one most connected
 * desks use (their own, else the default agent model); the reviewer's and the Architect's as
 * `GET /api/desks` shows them.
 */
export function currentModels(
  machines: readonly ConnectedMachine[],
  ownModelOf: (desk: string) => string | undefined,
  view: { defaultAgent: string | null; reviewer: string | null; architect: string | null },
): Record<SuggestionRole, string | undefined> {
  const desks = machines.flatMap((m) => Array.from({ length: m.slots }, (_, i) => deskName(m.hostname, i + 1)));
  return { desks: currentDeskModel(desks, ownModelOf, view.defaultAgent), reviewer: view.reviewer ?? undefined, architect: view.architect ?? undefined };
}

/** What applies a suggestion of `spec`: each machine's desks, or the role; nothing without a spec. */
function applying(role: SuggestionRole, spec: string | undefined, machines: readonly string[]): ModelSuggestion["apply"] {
  if (!spec) return [];
  if (role === "desks") return machines.map((target) => ({ kind: "desk" as const, target, model: spec }));
  return [{ kind: "role", target: role, model: spec }];
}

/**
 * Suggestions for every role, from track records by model over a period. `current` names each
 * role's model now (specs or names); `available` turns a suggested name into a spec to choose it
 * by; `machines` are the connected machines a desk suggestion would put on it.
 */
export function modelSuggestions(
  byModel: TrackRecords,
  since: string,
  current: Record<SuggestionRole, string | undefined>,
  available: readonly Pick<AvailableModel, "model" | "spec">[],
  machines: readonly string[],
): ModelSuggestions {
  const suggestions: ModelSuggestion[] = [];
  const notes: ModelSuggestions["notes"] = [];
  for (const role of ["desks", "reviewer", "architect"] as const) {
    const now = current[role] && modelName(current[role], available);
    const { suggestion, note } = suggestFor(role, byModel.rows, now);
    if (note) notes.push({ role, text: note });
    if (!suggestion) continue;
    const spec = available.find((a) => a.model === suggestion.suggested.model)?.spec;
    suggestions.push({ ...suggestion, ...(spec ? { spec } : {}), apply: applying(role, spec, machines) });
  }
  return { since, suggestions, notes };
}
