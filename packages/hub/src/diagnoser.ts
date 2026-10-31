import { createLogger, type Diagnosis } from "@aso/shared";
import { failedDiagnosis, failureSources, isCurrentDiagnosis, PRODUCT_OWNER_OFF, type ProductOwner } from "./llm/product-owner.js";
import type { Project } from "./projects.js";
import { diagnosisNotification, type PushNotification } from "./push/changes.js";
import { TaskError, type TaskRecord } from "./tasks.js";

const log = createLogger("product-owner");

/** How much of a failed task's transcript the product owner reads: what led up to the failure. */
export const DIAGNOSIS_TRANSCRIPT_ENTRIES = 300;

type Watched = Pick<TaskRecord, "state" | "retries" | "dismissedAt" | "supersededBy" | "diagnosis"> & { spec: { taskId: string } };

/** A reading the Hub was making when it stopped (seen for the first time, still diagnosing): make it again. */
function interruptedReading(t: Watched, before: string | undefined): boolean {
  return before === undefined && !t.dismissedAt && t.diagnosis?.state === "diagnosing" && isCurrentDiagnosis(t, t.diagnosis);
}

/** A task that failed since the last look and is still waiting for a reading. Seen for the first time (a Hub start), it's an old failure, not news. */
function newlyFailed(t: Watched, before: string | undefined): boolean {
  if (before === undefined || before === t.state || t.state !== "failed") return false;
  return !t.dismissedAt && !t.supersededBy && !isCurrentDiagnosis(t, t.diagnosis);
}

/** The task ids that failed since the last look, for a diagnosis: not dismissed or superseded, nor diagnosed for this failure. */
export function newFailures(seen: Map<string, string>, tasks: readonly Watched[]): string[] {
  const out: string[] = [];
  for (const t of tasks) {
    const before = seen.get(t.spec.taskId);
    seen.set(t.spec.taskId, t.state);
    if (interruptedReading(t, before) || newlyFailed(t, before)) out.push(t.spec.taskId);
  }
  return out;
}

/** Why a person can't ask about this task now, or undefined when they can. */
export function diagnosisBlocker(owner: ProductOwner | undefined, task: Pick<TaskRecord, "state" | "retries" | "diagnosis"> & { spec: { taskId: string } }): string | undefined {
  if (!owner) return PRODUCT_OWNER_OFF;
  if (task.state !== "failed") return `task ${task.spec.taskId} is ${task.state}; only failed tasks are diagnosed`;
  if (task.diagnosis?.state === "diagnosing") return `task ${task.spec.taskId} is being diagnosed`;
  return owner.unavailable();
}

/**
 * Runs the product owner on the Hub: watches for failures, reads each one (one at a time, in
 * order), keeps the diagnosis on the task when it is still that failure, and tells people.
 */
export class Diagnoser {
  /** Each task's state at the last look, so only failures from now on are read by themselves. */
  private readonly seen = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly owner: ProductOwner,
    private readonly notify: (n: PushNotification) => void,
  ) {}

  /** Queue the project's new failures (`ProjectSet` calls this on every change). */
  watch(p: Project): void {
    for (const id of newFailures(this.seen, p.tasks.list())) this.enqueue(p, id);
  }

  /** A person asks about a failed task: marked as being read at once, then queued. Throws why it can't. */
  request(p: Project, taskId: string): TaskRecord {
    const task = p.tasks.get(taskId)!;
    const why = diagnosisBlocker(this.owner, task);
    if (why) throw new TaskError(why, "conflict");
    this.begin(p, task);
    this.enqueue(p, taskId);
    return task;
  }

  private enqueue(p: Project, taskId: string): void {
    this.queue = this.queue.then(() => this.run(p, taskId)).catch((err: Error) => log.warn(`diagnosing ${taskId} failed: ${err.message}`));
  }

  private begin(p: Project, task: TaskRecord): void {
    const diagnosing: Diagnosis = { attempt: task.retries ?? 0, state: "diagnosing", at: new Date().toISOString() };
    p.tasks.setDiagnosis(task.spec.taskId, diagnosing);
  }

  private async run(p: Project, taskId: string): Promise<void> {
    const task = p.tasks.get(taskId);
    if (!task || task.state !== "failed") return;
    const attempt = task.retries ?? 0;
    const why = this.owner.unavailable();
    if (why) return p.tasks.setDiagnosis(taskId, failedDiagnosis(attempt, why));
    if (task.diagnosis?.state !== "diagnosing") this.begin(p, task);
    const diff = await p.repo.diff(`refs/heads/task/${taskId}`).catch(() => undefined);
    const subject = { kind: "task" as const, id: taskId };
    const last = p.transcripts.read(subject, -1, 0).last;
    const transcript = p.transcripts.read(subject, last - DIAGNOSIS_TRANSCRIPT_ENTRIES).entries;
    const { diagnosis, usage } = await this.owner.diagnose(task, failureSources(task, transcript, diff), attempt);
    if (usage) p.tasks.recordLlmUsage(taskId, usage);
    // Retried or dismissed meanwhile: this reading is of a failure nobody waits on.
    const now = p.tasks.get(taskId);
    if (!now || !isCurrentDiagnosis(now, diagnosis) || now.dismissedAt) return;
    p.tasks.setDiagnosis(taskId, diagnosis);
    if (diagnosis.state === "ready") this.notify(diagnosisNotification(p.id, now, diagnosis));
  }
}
