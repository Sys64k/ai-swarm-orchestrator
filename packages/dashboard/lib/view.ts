import type { HubNode, Plan, PlannedTask, Project, Task, TaskState, TranscriptEntry } from "./types.ts";

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
    case "awaiting_input":
      return { label: "Has questions", tone: "waiting" };
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
  project: string;
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

/** Plan states that wait for a person, and how "Needs you" words them. */
const PLAN_ASKS = {
  proposed: { reason: "Plan ready for your approval", label: "Approve?" },
  awaiting_input: { reason: "The Architect has questions", label: "Answer?" },
} as const;

export function homeView(tasks: readonly Task[], plans: readonly Plan[]): HomeView {
  const attention: AttentionItem[] = [
    ...plans
      .filter((p) => p.state in PLAN_ASKS)
      .map((p) => {
        const ask = PLAN_ASKS[p.state as keyof typeof PLAN_ASKS];
        return { kind: "plan" as const, id: p.planId, project: p.project, title: firstLine(p.requirement), reason: ask.reason, href: `/plans/${p.planId}`, badge: { label: ask.label, tone: "waiting" as Tone } };
      }),
    ...tasks
      .filter((t) => t.state === "failed")
      .map((t) => ({ kind: "task" as const, id: t.spec.taskId, project: t.project, title: t.spec.title, reason: t.detail ?? "Failed", href: `/tasks/${t.spec.taskId}`, badge: { label: "Failed", tone: "bad" as Tone } })),
    ...plans
      .filter((p) => p.state === "failed")
      .map((p) => ({ kind: "plan" as const, id: p.planId, project: p.project, title: firstLine(p.requirement), reason: p.error ?? "Planning failed", href: `/plans/${p.planId}`, badge: { label: "Failed", tone: "bad" as Tone } })),
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
  taskId: string | null;
  detail: string;
  outdated: boolean;
  status: { label: string; tone: Tone };
  actions: WorkerActions;
}

/** The worker buttons to show; the Hub decides which actions are allowed. */
export interface WorkerActions {
  drain: boolean;
  resume: boolean;
  restart: boolean;
  /** "Resume", or "Cancel restart" while a restart waits for the current job. */
  resumeLabel: string;
  restartConfirm: string;
  /** Why Restart is not offered, when the reason is not obvious from the state. */
  restartNote?: string;
}

export function workerViews(nodes: readonly HubNode[]): WorkerView[] {
  return nodes.filter((n) => n.nodeKind === "worker").map(workerView);
}

export function workerView(n: HubNode): WorkerView {
  const size = n.hardware ? `${n.hardware.cpu.logicalCores} cores, ${Math.round(n.hardware.memory.totalBytes / 1024 ** 3)} GiB` : undefined;
  const cpu = n.heartbeat ? `CPU ${Math.round(n.heartbeat.cpuLoadPercent)}%` : undefined;
  const build = n.version ? `build ${buildOf(n.version)}` : undefined;
  const name = n.hardware?.hostname ?? n.nodeId;
  return {
    nodeId: n.nodeId,
    name,
    taskId: n.currentTaskId,
    detail: [size, cpu, build].filter(Boolean).join(" · "),
    outdated: n.outdated === true,
    status: workerStatus(n),
    actions: workerActions(n, name),
  };
}

function workerStatus(n: HubNode): { label: string; tone: Tone } {
  if (n.restart === "sent") return { label: "Restarting", tone: "active" };
  if (n.restart === "pending") return { label: "Restart after job", tone: "waiting" };
  if (n.currentTaskId !== null) return { label: n.draining ? "Busy, draining" : "Busy", tone: "active" };
  if (n.draining) return { label: "Drained", tone: "waiting" };
  if (n.outdated) return { label: "Update", tone: "waiting" };
  return { label: "Idle", tone: "muted" };
}

function workerActions(n: HubNode, name: string): WorkerActions {
  const allowed = n.actions;
  return {
    drain: allowed?.drain === true,
    resume: allowed?.resume === true,
    restart: allowed?.restart === true,
    resumeLabel: n.restart === "pending" ? "Cancel restart" : "Resume",
    restartConfirm: `Restart ${name}? ${n.currentTaskId !== null ? "It finishes its current job first and takes no new ones meanwhile." : "It restarts now."}`,
    restartNote: allowed?.why.restart,
  };
}

/** The build part of a version (`0.1.0+e422cd7` → `e422cd7`); older nodes report only `0.1.0`. */
export function buildOf(version: string): string {
  const plus = version.indexOf("+");
  return plus === -1 ? version : version.slice(plus + 1);
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

/** Same rule as the Hub: the name becomes a folder, a URL segment and a Git path. */
export function projectNameProblem(name: string): string | undefined {
  if (!name) return "Give the project a name.";
  if (name.length > 64) return "At most 64 characters.";
  if (!/^[a-z0-9]/.test(name)) return "Start with a lowercase letter or a digit.";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return "Use lowercase letters, digits, - and _ only.";
  return undefined;
}

/** A project's one-line status, for lists. */
export function projectSummary(p: Project): { text: string; needsYou: boolean } {
  const questions = p.plansWithQuestions ?? 0;
  const parts = [
    p.plansAwaitingApproval ? `${p.plansAwaitingApproval} to approve` : "",
    questions ? `${questions} with questions` : "",
    p.tasks.failed ? `${p.tasks.failed} failed` : "",
    p.tasks.running ? `${p.tasks.running} running` : "",
    p.tasks.queued ? `${p.tasks.queued} queued` : "",
  ].filter(Boolean);
  const idle = p.tasks.total ? `${p.tasks.merged} of ${p.tasks.total} tasks merged` : "No tasks yet";
  return { text: parts.join(" · ") || idle, needsYou: p.plansAwaitingApproval > 0 || questions > 0 || p.tasks.failed > 0 };
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

/** One message in a plan's conversation, as the plan page shows it. */
export type ThreadItem =
  | { who: "you"; kind: "requirement" | "reply"; text: string; at: string }
  | { who: "architect"; kind: "questions"; questions: string[]; context?: string; at: string }
  | { who: "architect"; kind: "earlier-proposal"; summary: string; tasks: PlannedTask[]; at: string };

/** The requirement, then every question, answer, superseded proposal and change request. */
export function planThread(plan: Pick<Plan, "requirement" | "createdAt" | "dialogue">): ThreadItem[] {
  return [
    { who: "you", kind: "requirement", text: plan.requirement, at: plan.createdAt },
    ...(plan.dialogue ?? []).map((d): ThreadItem => {
      switch (d.kind) {
        case "questions":
          return { who: "architect", kind: "questions", questions: d.questions, context: d.context, at: d.at };
        case "proposal":
          return { who: "architect", kind: "earlier-proposal", summary: d.summary, tasks: d.tasks, at: d.at };
        case "reply":
          return { who: "you", kind: "reply", text: d.text, at: d.at };
      }
    }),
  ];
}

/** Mirrors MAX_PLAN_REPLIES in @aso/shared (plan-dialogue.ts): every reply is another planning round. */
export const MAX_PLAN_REPLIES = 10;

/** What a reply means right now: answering questions, asking for changes, or nothing (can't reply). */
export type ReplyMode = "answer" | "changes";

/** Mirrors replyMode in @aso/shared (the console doesn't depend on it). */
export function replyMode(plan: Pick<Plan, "state" | "dialogue">): ReplyMode | undefined {
  const replies = plan.dialogue?.filter((d) => d.kind === "reply").length ?? 0;
  if (replies >= MAX_PLAN_REPLIES) return undefined;
  if (plan.state === "awaiting_input") return "answer";
  if (plan.state === "proposed") return "changes";
  return undefined;
}

/** Words of the reply box, per kind of reply. */
export const REPLY_COPY: Record<ReplyMode, { label: string; placeholder: string; button: string; rows: number; primary: boolean }> = {
  answer: { label: "Your answers", placeholder: "Your answers", button: "Send answers", rows: 5, primary: true },
  changes: { label: "What should change", placeholder: "What should change? e.g. Use SQLite instead, and split the UI into its own task", button: "Ask for changes", rows: 3, primary: false },
};
