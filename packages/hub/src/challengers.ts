import { z } from "zod";
import type { ChallengerRole, JobRecord, TaskState, Trial } from "@aso/shared";
import { ROLE_RULES } from "./model-suggestions.js";

/**
 * Challengers: a model on trial in a role takes a share of its work, so it gathers the data
 * suggestions need to compare it, within a budget. Which work it takes is decided by a hash of the
 * work's id, not at random: the same task always gets the same answer. Pure.
 */

/** A trial as kept in models.json; `since`: when it began, its spending and samples count from then. */
export const ChallengerSchema = z.object({ spec: z.string().min(1), share: z.number(), budgetUsd: z.number(), since: z.string() });
export type Challenger = z.infer<typeof ChallengerSchema>;

/** What a trial needs of a task. */
export interface TrialTask {
  state: TaskState;
  challenger?: string;
  llm: { costUsd: number };
  jobs?: readonly JobRecord[];
}

/**
 * Whether a running trial takes the task `taskId`: by a hash of `<role>:<taskId>`, so the same task
 * always gets the same answer, and the desks' and the reviewer's trials take different tasks.
 */
export function takesTask(role: ChallengerRole, ch: Challenger, trial: Pick<Trial, "ended">, taskId: string): boolean {
  return !trial.ended && picked(`${role}:${taskId}`, ch.share);
}

/** Whether a task hasn't been built yet, so it may still start on a model on trial. */
export function isFresh(task: { challenger?: string; reworkRound: number; jobs?: readonly JobRecord[] }): boolean {
  return !task.challenger && task.reworkRound === 0 && !task.jobs?.some((j) => j.job === "implement" && j.endedAt);
}

/** Whether the work with this `key` falls in a `share` (0 to 1): a stable FNV-1a hash of the key. */
export function picked(key: string, share: number): boolean {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000 < share;
}

/**
 * How a trial stands. Desks: the settled tasks it started, and everything those tasks cost.
 * Reviewer: the met verdicts it gave since the trial began, and what its checks cost; by `name`, the
 * model's name as its provider calls it (what checks record), which can differ from its spec. It ends when it has the data suggestions need, or spent its budget.
 */
export function trialStatus(role: ChallengerRole, ch: Challenger, name: string, tasks: readonly TrialTask[]): Trial {
  let samples = 0;
  let spentUsd = 0;
  if (role === "desks") {
    for (const t of tasks) {
      // Tasks it took in this trial: started on it since then (a task not built yet counts already).
      const first = t.jobs?.find((j) => j.job === "implement");
      if (t.challenger !== ch.spec || (first && first.startedAt < ch.since)) continue;
      spentUsd += t.llm.costUsd;
      if (t.state === "merged" || t.state === "failed") samples++;
    }
  } else {
    for (const t of tasks) {
      for (const j of t.jobs ?? []) {
        if (j.job !== "implement" || j.acceptanceModel !== name || !j.endedAt || j.endedAt < ch.since) continue;
        spentUsd += j.acceptanceCostUsd ?? 0;
        if (j.acceptance === "met") samples++;
      }
    }
  }
  const needed = ROLE_RULES[role].minSamples;
  const ended = samples >= needed ? "enough data" : spentUsd >= ch.budgetUsd ? "budget spent" : undefined;
  return {
    model: ch.spec,
    share: ch.share,
    budgetUsd: ch.budgetUsd,
    since: ch.since,
    samples,
    needed,
    spentUsd: Math.round(spentUsd * 1e4) / 1e4,
    ...(ended ? { ended } : {}),
  };
}
