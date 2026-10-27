import { createLogger, DEFAULT_CHALLENGER_BUDGET_USD, type ChallengerRole, type SuggestionEvidence } from "@aso/shared";
import type { DeskModels, TuningLogEntry } from "./llm/desk-models.js";
import { EXPLORE_SHARE, MAX_POOL_SHARE, nextCandidate, REBALANCE_EVERY, rebalance, type PoolMember } from "./model-pool.js";

const log = createLogger("tuning");

/** What auto-tuning needs from the Hub. */
export interface TunerDeps {
  models: Pick<DeskModels, "setChallenger" | "setMembers" | "tuning" | "setTuning" | "addTuningLog">;
  /** A role's members, with how each one's trial stands. */
  poolOf(role: ChallengerRole): PoolMember[];
  /** Each model's record in a role over the period compared (track records by model). */
  evidence(role: ChallengerRole): SuggestionEvidence[];
  /** The role's own model now (its spec), if any. */
  base(role: ChallengerRole): string | undefined;
  /** A spec's name as track records keep it. */
  nameOf(spec: string): string;
  /** Make `spec` the role's own model in place of `from`. */
  promote(role: ChallengerRole, spec: string, from: string): Promise<void>;
  notify(title: string, body: string): void;
  now(): Date;
}

/** A person's change to a role's tuning, for the log: "auto-tuning on; candidates: a, b". */
export function tuningChangeText(change: { auto?: boolean; candidates?: readonly string[] }): string {
  const parts = [];
  if (change.auto !== undefined) parts.push(`auto-tuning ${change.auto ? "on" : "off"}`);
  if (change.candidates !== undefined) parts.push(`candidates: ${change.candidates.join(", ") || "none"}`);
  return parts.join("; ");
}

/**
 * One round of auto-tuning for a role, when it's on: start the next queued candidate when there's
 * room, and every `REBALANCE_EVERY` new samples, rebalance the shares (and switch the role's own
 * model when a member overtakes it). Every change is logged and notified. Without auto-tuning,
 * nothing happens.
 */
export async function tuneRole(role: ChallengerRole, deps: TunerDeps): Promise<void> {
  const tuning = deps.models.tuning(role);
  if (!tuning.auto) return;
  const at = deps.now().toISOString();
  const entries: TuningLogEntry[] = [];
  const say = (text: string) => entries.push({ at, role, text });

  const evidence = deps.evidence(role);
  const hasData = (spec: string) => evidence.some((e) => e.model === deps.nameOf(spec));
  const candidate = nextCandidate(tuning.candidates, deps.poolOf(role), hasData);
  if (candidate) {
    const candidates = tuning.candidates.filter((c) => c !== candidate);
    try {
      await deps.models.setChallenger(role, candidate, { share: EXPLORE_SHARE, budgetUsd: DEFAULT_CHALLENGER_BUDGET_USD[role], maxShare: MAX_POOL_SHARE }, deps.now());
      say(`started trying ${candidate} on ${Math.round(EXPLORE_SHARE * 100)}% of the work, up to $${DEFAULT_CHALLENGER_BUDGET_USD[role]}`);
    } catch (err) {
      say(`can't try ${candidate}: ${(err as Error).message}`);
    }
    await deps.models.setTuning(role, { candidates });
  }

  const samples = evidence.reduce((n, e) => n + e.samples, 0);
  const base = deps.base(role);
  if (base && samples - tuning.lastSamples >= REBALANCE_EVERY) {
    const r = rebalance(role, base, deps.poolOf(role), evidence, deps.nameOf, at);
    await deps.models.setMembers(role, r.members);
    if (r.promote) await deps.promote(role, r.promote, base);
    await deps.models.setTuning(role, { lastSamples: samples });
    for (const line of r.log) say(line);
  }

  if (!entries.length) return;
  await deps.models.addTuningLog(entries);
  for (const e of entries) log.info(`${role}: ${e.text}`);
  deps.notify(`Model mix for the ${role} changed`, entries.map((e) => e.text).join("\n"));
}
