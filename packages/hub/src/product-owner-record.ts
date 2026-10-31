import { DIAGNOSIS_ACTIONS, DIAGNOSIS_CAUSES, isRetryAction, type Diagnosis, type ProductOwnerRecord } from "@aso/shared";
import { isCurrentDiagnosis } from "./llm/product-owner.js";
import type { TaskRecord } from "./tasks.js";

type RecordedTask = Pick<TaskRecord, "project" | "state" | "retries" | "diagnosis" | "pastDiagnoses">;

/** What came of an accepted retry: merged, failed (or cancelled) again, or still going. */
export function retryOutcome(task: Pick<TaskRecord, "state" | "retries">, d: Pick<Diagnosis, "attempt">): "merged" | "failedAgain" | "underway" {
  // Accepting retried it once: a later retry, or ending failed or cancelled, means that try didn't work.
  if ((task.retries ?? 0) > d.attempt + 1 || task.state === "failed" || task.state === "cancelled") return "failedAgain";
  return task.state === "merged" ? "merged" : "underway";
}

function emptyRecord(): ProductOwnerRecord {
  return {
    diagnosed: 0,
    couldNot: 0,
    costUsd: 0,
    decisions: { accepted: 0, refused: 0, waiting: 0, unanswered: 0 },
    causes: Object.fromEntries(DIAGNOSIS_CAUSES.map((c) => [c, 0])) as ProductOwnerRecord["causes"],
    actions: Object.fromEntries(DIAGNOSIS_ACTIONS.map((a) => [a, { proposed: 0, accepted: 0, refused: 0 }])) as ProductOwnerRecord["actions"],
    retries: { accepted: 0, merged: 0, failedAgain: 0, underway: 0 },
    quotes: { total: 0, notFound: 0 },
  };
}

/** Count one diagnosis of `task` into `record`. */
function tally(record: ProductOwnerRecord, task: RecordedTask, d: Diagnosis): void {
  record.costUsd += d.costUsd ?? 0;
  if (d.state === "failed") record.couldNot++;
  if (d.state !== "ready") return;
  record.diagnosed++;
  if (d.cause) record.causes[d.cause]++;
  record.quotes.total += d.evidence?.length ?? 0;
  record.quotes.notFound += d.evidence?.filter((e) => !e.found).length ?? 0;
  const action = d.proposal?.action;
  if (action) record.actions[action].proposed++;
  const kind = d.decision?.kind;
  if (kind) {
    record.decisions[kind]++;
    if (action) record.actions[action][kind]++;
  } else if (isCurrentDiagnosis(task, d)) record.decisions.waiting++;
  else record.decisions.unanswered++;
  if (kind === "accepted" && isRetryAction(action)) {
    record.retries.accepted++;
    record.retries[retryOutcome(task, d)]++;
  }
}

/** The product owner's track record over `tasks` (only `project`'s, only diagnoses since `since`). */
export function productOwnerRecord(tasks: readonly RecordedTask[], filter: { project?: string; since?: string } = {}): ProductOwnerRecord {
  const since = filter.since ? Date.parse(filter.since) : -Infinity;
  const record = emptyRecord();
  for (const task of tasks) {
    if (filter.project && task.project !== filter.project) continue;
    for (const d of [...(task.pastDiagnoses ?? []), ...(task.diagnosis ? [task.diagnosis] : [])]) if (Date.parse(d.at) >= since) tally(record, task, d);
  }
  record.costUsd = Math.round(record.costUsd * 10_000) / 10_000;
  return record;
}
