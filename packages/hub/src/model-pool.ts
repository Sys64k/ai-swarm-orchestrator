import type { ChallengerRole, SuggestionEvidence, Trial } from "@aso/shared";
import { hashUnit, type Challenger } from "./challengers.js";
import { ROLE_RULES } from "./model-suggestions.js";

/**
 * The model pool of a role (the desks or the reviewer): its own model (the base) and members, each
 * with a share of the work. With auto-tuning on, members a person queued are tried one after
 * another, and every few settled samples the shares move toward the model that does the work for
 * the least, among those good enough; a member that comes to take more than the base becomes the
 * base. Pure: the Hub applies what it returns.
 */

/** Most of a role's work the members may take together; the base always keeps the rest. */
export const MAX_POOL_SHARE = 0.9;
/** A member that is good enough but not the cheapest keeps this share, so changes keep showing. */
export const MIN_KEEP_SHARE = 0.1;
/** How far a share moves in one rebalance. */
export const SHARE_STEP = 0.15;
/** New settled samples in a role between rebalances. */
export const REBALANCE_EVERY = 5;
/** Members still gathering data at once, and the share each starts with. */
export const MAX_EXPLORING = 2;
export const EXPLORE_SHARE = 0.2;

/** A member and how its trial stands. */
export interface PoolMember {
  member: Challenger;
  status: Trial;
}

const round = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** The share of the work the base takes: what the members still taking work leave. */
export function baseShare(members: readonly PoolMember[], auto: boolean): number {
  return round(1 - members.filter((m) => takesWork(m, auto)).reduce((n, m) => n + m.member.share, 0));
}

/** The desks that are on `model` now (their own model, else the default), to switch when another becomes the base. */
export function desksOnModel(desks: readonly string[], ownModelOf: (desk: string) => string | undefined, defaultModel: string | null, model: string): string[] {
  return desks.filter((d) => (ownModelOf(d) ?? defaultModel) === model);
}

/** Whether a member still takes work: with auto-tuning, until it's dropped; without, until its trial ended. */
export function takesWork(m: PoolMember, auto: boolean): boolean {
  if (!m.status.ended) return true;
  return auto && m.status.ended === "enough data";
}

/**
 * Which member a task starts on, by the hash of `<role>:<taskId>`'s place among the members'
 * shares (in their order); undefined: the base.
 */
export function memberFor(role: ChallengerRole, members: readonly PoolMember[], auto: boolean, taskId: string): string | undefined {
  const at = hashUnit(`${role}:${taskId}`);
  let upTo = 0;
  for (const m of members) {
    if (!takesWork(m, auto)) continue;
    upTo += m.member.share;
    if (at < upTo) return m.member.spec;
  }
  return undefined;
}

/** What a rebalance decided. */
export interface Rebalance {
  /** The members afterwards, with their new shares (dropped ones left out). */
  members: Challenger[];
  /** A member that now takes more than the base: it becomes the base. */
  promote?: string;
  /** What changed and why, a line each. */
  log: string[];
}

/**
 * Move a role's shares toward the model that does the work for the least, among those whose
 * quality is within the role's margin of the best. Only models with enough data are compared:
 * the base (`base`, its evidence by `nameOf(base)`) and members the track records have enough of. Exploring
 * members keep their share, or are dropped once their budget is spent. A compared member below
 * the margin is dropped; a good-enough one keeps at least `MIN_KEEP_SHARE`; the cheapest grows.
 * Shares move at most `SHARE_STEP` at a time.
 */
export function rebalance(
  role: ChallengerRole,
  base: string,
  members: readonly PoolMember[],
  evidence: readonly SuggestionEvidence[],
  nameOf: (spec: string) => string,
  now: string,
): Rebalance {
  const log: string[] = [];
  const min = ROLE_RULES[role].minSamples;
  const margin = ROLE_RULES[role].qualityMargin;
  const kept: Challenger[] = [];
  const compared: Array<{ spec: string; e: SuggestionEvidence; member?: Challenger }> = [];
  const of = (spec: string) => evidence.find((e) => e.model === nameOf(spec) && e.samples >= min);

  for (const { member, status } of members) {
    // Compared once the track records have enough of it (a former base has from before).
    const e = of(member.spec);
    if (e) compared.push({ spec: member.spec, e, member });
    else if (status.ended === "budget spent") log.push(`${member.spec} spent its $${member.budgetUsd} budget before it had ${min} samples: dropped`);
    else kept.push(member);
  }
  const baseEvidence = of(base);
  if (baseEvidence) compared.push({ spec: base, e: baseEvidence });

  if (compared.length < 2 || !baseEvidence) {
    // Nothing to weigh yet: compared members keep their shares.
    return { members: [...kept, ...compared.flatMap((c) => (c.member ? [c.member] : []))], log };
  }

  const bestQuality = Math.max(...compared.map((c) => c.e.quality));
  const good = compared.filter((c) => c.e.quality >= bestQuality - margin);
  const cheapest = [...good].sort((a, b) => a.e.unitCostUsd - b.e.unitCostUsd)[0];
  const exploring = kept.reduce((n, m) => n + m.share, 0);
  for (const c of compared) {
    if (!c.member) continue;
    if (!good.includes(c)) {
      log.push(`${c.spec} dropped: ${pct(c.e.quality)} against the best's ${pct(bestQuality)}`);
      continue;
    }
    const others = good.filter((g) => g !== c && g.member).length;
    // The cheapest grows toward everything the exploring members and the others' minimum leave.
    const target = c === cheapest ? MAX_POOL_SHARE - exploring - others * MIN_KEEP_SHARE : MIN_KEEP_SHARE;
    const share = round(Math.max(MIN_KEEP_SHARE, c.member.share + Math.max(-SHARE_STEP, Math.min(SHARE_STEP, target - c.member.share))));
    if (share !== c.member.share) {
      log.push(`${c.spec}: ${pct(c.member.share)} → ${pct(share)} (${usd(c.e.unitCostUsd)} a unit, ${pct(c.e.quality)}${c === cheapest ? ", the cheapest good enough" : ""})`);
    }
    kept.push({ ...c.member, share });
  }

  const baseLeft = round(1 - kept.reduce((n, m) => n + m.share, 0));
  const top = [...kept].sort((a, b) => b.share - a.share)[0];
  if (top && top.share > baseLeft) {
    log.push(`${top.spec} now takes ${pct(top.share)} against ${base}'s ${pct(baseLeft)}: it becomes the base, and ${base} a member`);
    const rest = kept.filter((m) => m !== top);
    const oldBase: Challenger = { spec: base, share: baseLeft, budgetUsd: top.budgetUsd, since: now };
    return { members: [...rest, oldBase], promote: top.spec, log };
  }
  return { members: kept, log };
}

/**
 * The next queued candidate to start exploring, when fewer than `MAX_EXPLORING` members are
 * exploring and the pool has room for its share; undefined otherwise.
 */
export function nextCandidate(candidates: readonly string[], members: readonly PoolMember[], hasData: (spec: string) => boolean): string | undefined {
  const exploring = members.filter((m) => !m.status.ended && !hasData(m.member.spec)).length;
  const taken = members.reduce((n, m) => n + m.member.share, 0);
  if (exploring >= MAX_EXPLORING || taken + EXPLORE_SHARE > MAX_POOL_SHARE + 1e-9) return undefined;
  return candidates.find((c) => !members.some((m) => m.member.spec === c));
}
