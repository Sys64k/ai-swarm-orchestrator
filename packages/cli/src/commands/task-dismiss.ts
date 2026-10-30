import { hubHttpBase } from "@aso/shared";
import { api } from "../hub-api.js";

export interface TaskDismissOptions {
  hub: string;
  failed?: boolean;
  project?: string;
}

interface TaskView {
  project: string;
  state: string;
  spec: { taskId: string };
  supersededBy?: string;
  dismissedAt?: string;
}

/** The failed tasks still in "Needs you", in one project or all: what `--failed` dismisses. */
export function failedToDismiss(tasks: readonly TaskView[], project?: string): string[] {
  return tasks.filter((t) => t.state === "failed" && !t.supersededBy && !t.dismissedAt && (!project || t.project === project)).map((t) => t.spec.taskId);
}

export async function taskDismissCommand(taskIds: string[], opts: TaskDismissOptions): Promise<void> {
  const base = hubHttpBase(opts.hub);
  if (opts.failed === (taskIds.length > 0)) throw new Error("name the tasks to dismiss, or use --failed (with --project to keep to one)");
  const ids = opts.failed ? failedToDismiss(await api<TaskView[]>(base, "/api/tasks"), opts.project) : taskIds;
  if (!ids.length) return console.log("no failed tasks to dismiss");
  for (const id of ids) await api(base, `/api/tasks/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
  console.log(`dismissed ${ids.length} task${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`);
}
