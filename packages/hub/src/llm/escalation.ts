/**
 * Which model a task's agent works with each round. The desk's model (or the default) tries
 * first; after `juniorRounds` rework rounds the task goes up the ladder of stronger models, one
 * step per further round. A model whose API refused this task (a bad request, a refused key, an
 * unknown model) is skipped from then on, so the task moves to another model instead of failing.
 */
export interface EscalationPolicy {
  /** Stronger models, weakest first, as specs (`anthropic/claude-sonnet-5-5`). */
  ladder: string[];
  /** Rounds the desk's model gets (the first attempt is round 0) before the ladder takes over. */
  juniorRounds: number;
}

/** Rework rounds on the desk's model before a task escalates, unless set otherwise. */
export const DEFAULT_JUNIOR_ROUNDS = 2;

export interface RoundModel {
  /** The model's spec; undefined: the Hub's default agent model. */
  spec?: string;
  /** Why this model, for the task's history; undefined for the default with nothing to explain. */
  why?: string;
}

/** A task as escalation sees it. */
export interface EscalationTask {
  reworkRound: number;
  /** Models whose API refused this task (canonical specs). */
  refusedModels?: readonly string[];
}

/** A spec in today's form, so models can be compared: `claude-…` is Anthropic's, `openai:…` the .env server's. */
export function canonicalSpec(spec: string): string {
  const s = spec.trim();
  if (s.startsWith("openai:")) return `local/${s.slice("openai:".length)}`;
  if (s.startsWith("claude-")) return `anthropic/${s}`;
  return s;
}

const escalatedWhy = (reworkRound: number): string =>
  reworkRound === 0 ? "the escalation model: no junior rounds" : `escalated after ${reworkRound} rework round${reworkRound === 1 ? "" : "s"}`;
const refusedWhy = (refused: ReadonlySet<string>): string => `${[...refused].join(", ")} refused this task`;

/**
 * The model for a task's next round. `desk` is the desk's own model (undefined: the default),
 * `defaultSpec` the Hub's default agent model.
 */
export function roundModel(policy: EscalationPolicy | undefined, task: EscalationTask, desk: string | undefined, defaultSpec: string | undefined): RoundModel {
  const refused = new Set(task.refusedModels ?? []);
  const usable = (spec: string | undefined): spec is string => spec !== undefined && !refused.has(canonicalSpec(spec));
  const isDefault = (spec: string) => defaultSpec !== undefined && canonicalSpec(spec) === canonicalSpec(defaultSpec);
  const pick = (spec: string, why: string): RoundModel => (isDefault(spec) ? { why } : { spec, why });
  const deskChoice: RoundModel = desk === undefined ? {} : { spec: desk, why: "this desk's model" };
  const seniors = (policy?.ladder ?? []).filter(usable);

  // 1. Past the junior rounds: a step up the ladder per round.
  if (policy && seniors.length && task.reworkRound >= policy.juniorRounds) {
    return pick(seniors[Math.min(task.reworkRound - policy.juniorRounds, seniors.length - 1)], escalatedWhy(task.reworkRound));
  }
  // 2. The desk's own model (or the default for a desk without one), unless it refused this task.
  const own = desk ?? defaultSpec;
  if (own === undefined || usable(own)) return deskChoice;
  // 3. It refused: the default, else the ladder's first model.
  if (usable(defaultSpec)) return { why: `the default; ${refusedWhy(refused)}` };
  if (seniors.length) return pick(seniors[0], refusedWhy(refused));
  // 4. Nothing else to try: the desk's model, which fails the task as before.
  return deskChoice;
}

/** The spec a round actually calls (its own, or the default's), in canonical form; undefined when there is none. */
export function calledSpec(choice: RoundModel, defaultSpec: string | undefined): string | undefined {
  const spec = choice.spec ?? defaultSpec;
  return spec === undefined ? undefined : canonicalSpec(spec);
}

/** Whether another model could take a task's next round once `refusedSpec` (canonical) is skipped too. */
export function canSwitchFrom(
  policy: EscalationPolicy | undefined,
  task: EscalationTask,
  desk: string | undefined,
  defaultSpec: string | undefined,
  refusedSpec: string,
): boolean {
  const next = roundModel(policy, { ...task, refusedModels: [...(task.refusedModels ?? []), refusedSpec] }, desk, defaultSpec);
  const spec = calledSpec(next, defaultSpec);
  return spec !== undefined && spec !== refusedSpec;
}

/**
 * The Hub's escalation policy from its settings: off with `escalation: false`; the ladder is
 * `escalateTo`, else the Architect's model; models the Hub can't use (`canUse` false) are left
 * out. Undefined when no ladder model is left.
 */
export function buildEscalationPolicy(
  settings: { escalation?: boolean; escalateTo?: string[]; model?: string; juniorRounds?: number },
  canUse: (spec: string) => boolean,
): EscalationPolicy | undefined {
  if (settings.escalation === false) return undefined;
  const wanted = settings.escalateTo?.length ? settings.escalateTo : settings.model ? [settings.model] : [];
  const ladder = wanted.filter(canUse);
  return ladder.length ? { ladder, juniorRounds: settings.juniorRounds ?? DEFAULT_JUNIOR_ROUNDS } : undefined;
}
