import { DIAGNOSIS_ACTION_LABEL, type Diagnosis } from "@aso/shared";
import type { PlanRecord } from "../plans.js";
import type { TaskRecord } from "../tasks.js";

/** What a phone shows; the console's service worker turns it into a notification. */
export interface PushNotification {
  title: string;
  body: string;
  /** Console path opened when the notification is tapped (always starts with a single `/`). */
  url: string;
  /** Notifications with the same tag replace each other (one per task or plan). */
  tag: string;
}

export interface ProjectState {
  id: string;
  tasks: readonly TaskRecord[];
  plans: readonly PlanRecord[];
}

/**
 * The moments worth interrupting someone for, found by comparing each task's and plan's state
 * with the last one seen. `seen` is updated in place. Records seen for the first time (a Hub
 * start, a new task) never notify: only transitions do.
 */
export function notableChanges(seen: Map<string, string>, project: ProjectState): PushNotification[] {
  const changed = (key: string, state: string) => {
    const before = seen.get(key);
    seen.set(key, state);
    return before !== undefined && before !== state;
  };
  return [
    ...project.plans.filter((p) => changed(`plan:${p.planId}`, p.state)).map((p) => planNotification(project.id, p)),
    // A task waiting for review counts as changed once its pull request is open, not before.
    ...project.tasks.filter((t) => changed(`task:${t.spec.taskId}`, taskStage(t))).map((t) => taskNotification(project, t)),
    // The first rework round is routine; from the second on, the task is struggling.
    ...project.tasks.filter((t) => changed(`rework:${t.spec.taskId}`, String(t.reworkRound)) && t.reworkRound >= 2).map((t) => reworkNotification(project.id, t)),
  ].filter((n): n is PushNotification => n !== undefined);
}

function reworkNotification(project: string, task: TaskRecord): PushNotification {
  return notification(project, `rework round ${task.reworkRound}`, [task.spec.title, task.rework?.reason && firstLine(task.rework.reason)], "task", task.spec.taskId);
}

function planNotification(project: string, plan: PlanRecord): PushNotification | undefined {
  const what = firstLine(plan.requirement);
  if (plan.state === "proposed") return notification(project, "plan ready for approval", [what, `${plural(plan.tasks?.length ?? 0, "task")} proposed`], "plan", plan.planId);
  if (plan.state === "awaiting_input") return notification(project, "the Architect has questions", [what, plan.questions?.[0]], "plan", plan.planId);
  if (plan.state === "failed") return notification(project, "planning failed", [what, plan.error], "plan", plan.planId);
  return undefined;
}

/** The pull request a task waits on, once it is open (before that there is nothing to review). */
function prToReview(task: TaskRecord) {
  return task.state === "awaiting_review" ? task.review?.pr : undefined;
}

function taskStage(task: TaskRecord): string {
  const pr = prToReview(task);
  return pr ? `${task.state}:${pr.number}` : task.state;
}

function taskNotification(project: ProjectState, task: TaskRecord): PushNotification | undefined {
  const id = task.spec.taskId;
  const pr = prToReview(task);
  if (pr) return notification(project.id, "ready for your review", [task.spec.title, `Pull request #${pr.number} on GitHub`], "task", id);
  if (task.state === "awaiting_review") return undefined;
  if (task.state === "failed") return notification(project.id, "task failed", [task.spec.title, task.detail], "task", id);
  if (task.state !== "merged") return undefined;
  const plan = planOf(project, id);
  if (!plan) return notification(project.id, "task merged", [task.spec.title], "task", id);
  const ids = Object.values(plan.taskIds ?? {});
  // `task` itself may not be updated in `project.tasks` yet when this runs.
  const done = ids.every((t) => t === id || project.tasks.find((x) => x.spec.taskId === t)?.state === "merged");
  return done ? notification(project.id, "plan done", [firstLine(plan.requirement), `All ${plural(ids.length, "task")} merged`], "plan", plan.planId) : undefined;
}

function planOf(project: ProjectState, taskId: string): PlanRecord | undefined {
  return project.plans.find((p) => Object.values(p.taskIds ?? {}).includes(taskId));
}

/** One notification per task or plan: its console page and a tag so newer news replaces older. */
export function notification(project: string, what: string, lines: Array<string | undefined>, kind: "plan" | "task", id: string): PushNotification {
  return {
    title: `${project}: ${what}`,
    body: clip(lines.filter(Boolean).join("\n"), 600),
    url: `/${kind}s/${encodeURIComponent(id)}`,
    tag: `${kind}-${id}`,
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function firstLine(text: string): string {
  return clip(text.trim().split("\n")[0] ?? "", 120);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The product owner's diagnosis of a failed task: what happened, and what it proposes for you to accept or refuse. */
export function diagnosisNotification(project: string, task: TaskRecord, d: Diagnosis): PushNotification {
  const proposal = d.proposal && DIAGNOSIS_ACTION_LABEL[d.proposal.action];
  return notification(project, "why it failed", [task.spec.title, d.summary, proposal && `Proposes: ${proposal.charAt(0).toLowerCase()}${proposal.slice(1)}`], "task", task.spec.taskId);
}
