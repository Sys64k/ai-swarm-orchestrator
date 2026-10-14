import type { HubNode, Plan, Task, TaskState, TranscriptEntry } from "./types.ts";

/** Colour family of a state badge. */
export type Tone = "active" | "waiting" | "good" | "bad" | "muted";

const TASK_TONE: Record<TaskState, Tone> = {
  pending: "waiting",
  assigned: "active",
  in_progress: "active",
  verifying: "active",
  awaiting_qa: "waiting",
  testing: "active",
  merging: "active",
  merged: "good",
  failed: "bad",
  cancelled: "muted",
};

const TASK_LABEL: Record<TaskState, string> = {
  pending: "Queued",
  assigned: "Starting",
  in_progress: "Working",
  verifying: "Checking push",
  awaiting_qa: "Waiting for QA",
  testing: "Testing",
  merging: "Merging",
  merged: "Merged",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function taskBadge(task: Pick<Task, "state" | "detachedAt" | "waitingReason">): { label: string; tone: Tone } {
  if (task.detachedAt !== undefined) return { label: "Worker offline", tone: "waiting" };
  if (task.state === "pending" && task.waitingReason?.startsWith("blocked")) return { label: "Blocked", tone: "bad" };
  if (task.state === "pending" && task.waitingReason?.startsWith("waiting for")) return { label: "Waiting", tone: "muted" };
  return { label: TASK_LABEL[task.state], tone: TASK_TONE[task.state] };
}

export function planBadge(plan: Pick<Plan, "state">): { label: string; tone: Tone } {
  switch (plan.state) {
    case "pending":
      return { label: "Queued", tone: "waiting" };
    case "planning":
      return { label: "Planning", tone: "active" };
    case "proposed":
      return { label: "Needs approval", tone: "waiting" };
    case "approved":
      return { label: "Approved", tone: "good" };
    case "rejected":
      return { label: "Rejected", tone: "muted" };
    case "failed":
      return { label: "Failed", tone: "bad" };
  }
}

const RUNNING: ReadonlySet<TaskState> = new Set(["assigned", "in_progress", "verifying", "awaiting_qa", "testing", "merging"]);
const FINISHED: ReadonlySet<TaskState> = new Set(["merged", "failed", "cancelled"]);

/** Work may still happen on the task (its transcript can grow). */
export function isLive(state: TaskState): boolean {
  return !FINISHED.has(state);
}

/** What a person can do with the task right now (mirrors the Hub's cancel/retry rules). */
export function taskActions(task: Pick<Task, "state">): { retry: boolean; cancel: boolean } {
  return {
    retry: task.state === "failed" || task.state === "cancelled",
    cancel: isLive(task.state) && task.state !== "merging",
  };
}

export interface AttentionItem {
  kind: "plan" | "task";
  id: string;
  title: string;
  reason: string;
  href: string;
  badge: { label: string; tone: Tone };
}

export interface HomeView {
  /** Things only a person can move forward, most urgent first. */
  attention: AttentionItem[];
  /** Plans being written or worked on. */
  activePlans: Plan[];
  running: Task[];
  queued: Task[];
  /** Merged or cancelled, newest first. */
  done: Task[];
}

export function homeView(tasks: readonly Task[], plans: readonly Plan[]): HomeView {
  const attention: AttentionItem[] = [
    ...plans
      .filter((p) => p.state === "proposed")
      .map((p) => ({ kind: "plan" as const, id: p.planId, title: firstLine(p.requirement), reason: "Plan ready for your approval", href: `/plans/${p.planId}`, badge: { label: "Approve?", tone: "waiting" as Tone } })),
    ...tasks
      .filter((t) => t.state === "failed")
      .map((t) => ({ kind: "task" as const, id: t.spec.taskId, title: t.spec.title, reason: t.detail ?? "Failed", href: `/tasks/${t.spec.taskId}`, badge: { label: "Failed", tone: "bad" as Tone } })),
    ...plans
      .filter((p) => p.state === "failed")
      .map((p) => ({ kind: "plan" as const, id: p.planId, title: firstLine(p.requirement), reason: p.error ?? "Planning failed", href: `/plans/${p.planId}`, badge: { label: "Failed", tone: "bad" as Tone } })),
  ];
  const byUpdate = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);
  return {
    attention,
    activePlans: plans.filter((p) => p.state === "pending" || p.state === "planning" || (p.state === "approved" && !planFinished(p, tasks))),
    running: tasks.filter((t) => RUNNING.has(t.state)),
    queued: tasks.filter((t) => t.state === "pending"),
    // Failed tasks are listed under "Needs you" until someone retries them.
    done: tasks.filter((t) => t.state === "merged" || t.state === "cancelled").sort(byUpdate),
  };
}

export interface PlanProgress {
  merged: number;
  failed: number;
  total: number;
}

export function planProgress(plan: Pick<Plan, "taskIds">, tasks: readonly Task[]): PlanProgress {
  const ids = Object.values(plan.taskIds ?? {});
  const states = ids.map((id) => tasks.find((t) => t.spec.taskId === id)?.state);
  return {
    merged: states.filter((s) => s === "merged").length,
    failed: states.filter((s) => s === "failed" || s === "cancelled").length,
    total: ids.length,
  };
}

function planFinished(plan: Plan, tasks: readonly Task[]): boolean {
  const p = planProgress(plan, tasks);
  return p.total > 0 && p.merged === p.total;
}

export interface WorkerView {
  nodeId: string;
  name: string;
  busy: boolean;
  taskId: string | null;
  detail: string;
}

export function workerViews(nodes: readonly HubNode[]): WorkerView[] {
  return nodes
    .filter((n) => n.nodeKind === "worker")
    .map((n) => ({
      nodeId: n.nodeId,
      name: n.hardware?.hostname ?? n.nodeId,
      busy: n.currentTaskId !== null,
      taskId: n.currentTaskId,
      detail: [n.roles?.join(", "), n.heartbeat ? `CPU ${Math.round(n.heartbeat.cpuLoadPercent)}%` : undefined].filter(Boolean).join(" · "),
    }));
}

/** One line of the terminal view. */
export interface TerminalLine {
  seq: number;
  at: string;
  style: "say" | "command" | "tool" | "output" | "error" | "event" | "pass" | "fail";
  text: string;
  /** Output shown under the line (collapsed when long). */
  body?: string;
}

/**
 * Turn transcript entries into terminal lines: commands look like a shell, file tools like a
 * log. Successful results of quiet tools (read, list, search…) are left out unless asked for.
 */
export function terminalLines(entries: readonly TranscriptEntry[], opts: { showQuiet?: boolean } = {}): TerminalLine[] {
  return entries.filter((e) => opts.showQuiet || !isQuiet(e)).map((e) => {
    const base = { seq: e.seq, at: e.at };
    switch (e.kind) {
      case "text":
        return { ...base, style: "say", text: e.text };
      case "call":
        return { ...base, ...describeCall(e.name, e.input) };
      case "result":
        return { ...base, style: e.isError ? "error" : "output", text: resultHeadline(e.name, e.content, e.isError), body: resultBody(e.name, e.content) };
      case "event":
        return { ...base, style: "event", text: e.text };
      case "qa":
        return { ...base, style: e.outcome, text: `QA ${e.outcome === "pass" ? "passed" : "failed"}: ${e.summary}`, body: e.output };
    }
  });
}

function describeCall(name: string, input: Record<string, unknown>): Pick<TerminalLine, "style" | "text" | "body"> {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "run_command":
      return { style: "command", text: `$ ${Array.isArray(input.argv) ? (input.argv as unknown[]).map(String).join(" ") : ""}` };
    case "read_file":
      return { style: "tool", text: `read ${str("path")}` };
    case "list_files":
      return { style: "tool", text: `list ${str("path") || "."}` };
    case "search":
      return { style: "tool", text: `search ${str("pattern")}${str("path") ? ` in ${str("path")}` : ""}` };
    case "write_file":
      return { style: "tool", text: `write ${str("path")}`, body: str("content") || undefined };
    case "edit_file":
      return { style: "tool", text: `edit ${str("path")}`, body: str("new_string") || undefined };
    case "delete_file":
      return { style: "tool", text: `delete ${str("path")}` };
    case "request_dependencies":
      return {
        style: "tool",
        text: `add packages ${Array.isArray(input.packages) ? (input.packages as Array<{ name?: unknown }>).map((p) => String(p.name)).join(", ") : ""}`,
      };
    case "set_package_scripts":
      return { style: "tool", text: `set scripts ${Object.keys((input.scripts as Record<string, unknown>) ?? {}).join(", ")}` };
    default:
      return { style: "tool", text: name };
  }
}

/** Command output goes in the body; for quiet tools only errors are worth a line. */
function resultHeadline(name: string | undefined, content: string, isError: boolean): string {
  if (name === "run_command") return firstLine(content);
  return isError ? firstLine(content) : `${name ?? "tool"} ok`;
}

function resultBody(name: string | undefined, content: string): string | undefined {
  if (name === "run_command") return content.split("\n").slice(1).join("\n").trim() || undefined;
  if (name === "read_file" || name === "list_files" || name === "search") return content;
  return content.includes("\n") ? content : undefined;
}

/** Results of quiet tools (read, list…) that succeeded add noise to the terminal view. */
export function isQuiet(entry: TranscriptEntry): boolean {
  return entry.kind === "result" && !entry.isError && entry.name !== "run_command";
}

/** Long output shows its last lines (where errors are) until expanded. */
export function previewBody(body: string | undefined, expanded: boolean, maxLines: number): { text?: string; lines: number; truncated: boolean } {
  if (!body) return { lines: 0, truncated: false };
  const lines = body.split("\n");
  const truncated = !expanded && lines.length > maxLines;
  return { text: truncated ? lines.slice(-maxLines).join("\n") : body, lines: lines.length, truncated };
}

export function formatUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function firstLine(text: string, max = 120): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
