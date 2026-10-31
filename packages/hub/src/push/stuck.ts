import { TASK_AT_WORK } from "@aso/shared";
import type { TaskRecord } from "../tasks.js";
import { notification, type PushNotification } from "./changes.js";
import { duration } from "./workers.js";

/** How long a task at work may go without any progress (an event or a model turn) before you're told. */
export const STUCK_ALERT_MS = 60 * 60_000;

/** When a task last moved: its last event or its agent's last model turn. */
export function lastProgress(task: TaskRecord): number {
  return Math.max(Date.parse(task.updatedAt), Date.parse(task.agentLog.at(-1)?.at ?? "") || 0);
}

/**
 * Tasks at work (on a worker, in QA, merging) with no progress for `stuckMs`: each stall is told
 * once. `told` (task id → the progress time already told about) is updated in place.
 */
export function stuckTasks(told: Map<string, number>, project: string, tasks: readonly TaskRecord[], now: number, stuckMs = STUCK_ALERT_MS): PushNotification[] {
  const out: PushNotification[] = [];
  for (const task of tasks) {
    const since = lastProgress(task);
    if (!TASK_AT_WORK[task.state] || now - since < stuckMs || told.get(task.spec.taskId) === since) continue;
    told.set(task.spec.taskId, since);
    out.push(notification(project, "no progress", [task.spec.title, stuckLine(task, now - since)], "task", task.spec.taskId));
  }
  return out;
}

function stuckLine(task: TaskRecord, idleMs: number): string {
  const where = task.nodeId ?? task.qaNodeId;
  return `Nothing has happened for ${duration(idleMs)} (${task.state.replaceAll("_", " ")}${where ? ` on ${where}` : ""}). Its page shows the last thing it did.`;
}
