import type { RetryTaskBody, TaskSpec } from "@aso/shared";

/** A task corrected before a retry: its new spec, what the agent is told, and lines for its history. */
export interface CorrectedTask {
  spec: TaskSpec;
  /** Appended to the retry's rework reason; empty when nothing changed. */
  brief: string;
  /** What changed, keeping what it was: the task's history is the only record of the old text. */
  history: string[];
}

const quoted = (items: readonly string[]) => items.map((c) => `"${c}"`).join(", ") || "none";
const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The task with a person's corrections (its description, its acceptance criteria) applied. Only
 * what differs counts as changed, so resending the same text changes nothing.
 */
export function correctTask(spec: TaskSpec, edit: RetryTaskBody): CorrectedTask {
  const description = edit.description !== undefined && edit.description !== spec.description ? edit.description : undefined;
  const criteria = edit.acceptanceCriteria !== undefined && !sameList(edit.acceptanceCriteria, spec.acceptanceCriteria) ? edit.acceptanceCriteria : undefined;
  const history: string[] = [];
  const told: string[] = [];
  if (description !== undefined) {
    history.push(`description corrected by a person; it was: ${spec.description}`);
    told.push("its description");
  }
  if (criteria !== undefined) {
    history.push(`acceptance criteria corrected by a person; they were: ${quoted(spec.acceptanceCriteria)}`);
    told.push("its acceptance criteria");
  }
  const brief = told.length
    ? ` A person corrected the task since: ${told.join(" and ")} changed. Work to the task as it is now; where your branch follows the old text, change it.`
    : "";
  return {
    spec: { ...spec, ...(description !== undefined ? { description } : {}), ...(criteria !== undefined ? { acceptanceCriteria: criteria } : {}) },
    brief,
    history,
  };
}
