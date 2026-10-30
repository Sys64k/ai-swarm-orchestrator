import type {
  ChallengerRole,
  Desks,
  Trial,
  ModelSuggestion,
  ModelSuggestions,
  SuggestionRole,
  Acceptance, Models, Price, Provider, ProviderPreset, CheckState, QualityNoteKind, DeployStatus, DiffFile, HubNode, HubUpdate, WorkerKey, Plan, PlannedTask, Project, ReviewChecks, Task, TaskDiff, TaskState, TrackRecordKey, TrackRecordRow, TranscriptEntry } from "./types.ts";

import { PROVIDER_ID } from "./hub-routes.ts";

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
  awaiting_review: "waiting",
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
  awaiting_review: "Review",
  merged: "Merged",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function taskBadge(task: Pick<Task, "state" | "detachedAt" | "waitingReason" | "supersededBy">): { label: string; tone: Tone } {
  // A newer task does its job: not a failure anyone needs to act on.
  if (task.supersededBy && (task.state === "failed" || task.state === "cancelled")) return { label: "Superseded", tone: "muted" };
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
export function taskActions(task: Pick<Task, "state" | "supersededBy">): { retry: boolean; cancel: boolean } {
  return {
    // A superseded task's job is done by a newer one: nothing to retry.
    retry: (task.state === "failed" || task.state === "cancelled") && !task.supersededBy,
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
    ...tasks.flatMap((t) => {
      const review = t.state === "awaiting_review" ? reviewView(t) : undefined;
      return review ? [{ kind: "task" as const, id: t.spec.taskId, project: t.project, title: t.spec.title, reason: review.text, href: `/tasks/${t.spec.taskId}`, badge: { label: "Review?", tone: "waiting" as Tone } }] : [];
    }),
    ...tasks
      .filter((t) => t.state === "failed" && !t.supersededBy)
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

/** A task's pull request as the console words it, while one is involved. */
export function reviewView(task: Pick<Task, "state" | "review">): { text: string; url?: string; error?: string } | undefined {
  const r = task.review;
  if (!r) return undefined;
  const rounds = r.rounds ? ` (after ${r.rounds} round${r.rounds === 1 ? "" : "s"} of changes)` : "";
  if (task.state === "awaiting_review") {
    if (!r.pr) return { text: "Opening a pull request on GitHub", error: r.error };
    return { text: `Pull request #${r.pr.number} is ready for your review${rounds}`, url: r.pr.url, error: r.error };
  }
  if (!r.pr) return undefined;
  if (task.state === "merged") return { text: `Merged as pull request #${r.pr.number}`, url: r.pr.url };
  if (task.state === "cancelled") return { text: `Pull request #${r.pr.number} was closed`, url: r.pr.url };
  return { text: `Changes requested on pull request #${r.pr.number}; an agent is on it${rounds}`, url: r.pr.url };
}

/** The task page's link to its pull request on GitHub; the review itself happens on the page. */
export function reviewLink(task: Pick<Task, "review">): { label: string; url: string } | undefined {
  const pr = task.review?.pr;
  return pr && { label: `Pull request #${pr.number} on GitHub`, url: pr.url };
}

/** Whether the task page offers Approve and Ask for changes. */
export function canReview(task: Pick<Task, "state" | "review">): boolean {
  return task.state === "awaiting_review" && !!task.review?.pr;
}

/** Whether the task has a commit of its own to show as changes. */
export function hasChanges(task: Pick<Task, "state" | "commit">): boolean {
  return !!task.commit && task.state !== "merged" && task.state !== "cancelled";
}

const CHECK_TONE: Record<CheckState, Tone> = { passing: "good", failing: "bad", pending: "waiting", skipped: "muted" };
const CHECK_LABEL: Record<CheckState, string> = { passing: "passed", failing: "failed", pending: "running", skipped: "skipped" };

export function checkBadge(state: CheckState): { label: string; tone: Tone } {
  return { label: CHECK_LABEL[state], tone: CHECK_TONE[state] };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One line about a pull request's checks. */
export function checksSummary(checks: ReviewChecks): { text: string; tone: Tone } {
  const named = (state: CheckState) => checks.checks.filter((c) => c.state === state);
  if (checks.mergeable === false) return { text: "Conflicts with main: the Hub sends it back to an agent to rebase", tone: "bad" };
  switch (checks.overall) {
    case "failing": {
      const failing = named("failing");
      return { text: `${plural(failing.length, "check")} failed: ${failing.map((c) => c.name).join(", ")}`, tone: "bad" };
    }
    case "unknown":
      return { text: `Checks can't be read: ${checks.error ?? "unknown error"}`, tone: "waiting" };
    case "pending":
      return { text: `${plural(named("pending").length, "check")} still running`, tone: "waiting" };
    case "passing":
      return { text: `${plural(named("passing").length, "check")} passed`, tone: "good" };
    case "none":
      return { text: "No checks run on this pull request", tone: "muted" };
  }
}

export type TaskTab = "live" | "changes" | "screenshots" | "details";

/**
 * The task page's tab: the person's choice, else the changes while a review waits, else the live
 * view. On a wide screen the details sit beside the tabs, so they aren't one.
 */
export function currentTab(chosen: TaskTab | undefined, task: Pick<Task, "state" | "review" | "commit" | "screenshots">, wide = false): TaskTab {
  if (chosen === "changes" && !hasChanges(task)) return "live"; // e.g. the work went back to an agent
  if (chosen === "screenshots" && !task.screenshots?.files.length) return "live"; // a later QA run took none
  if (chosen === "details" && wide) return canReview(task) ? "changes" : "live";
  return chosen ?? (canReview(task) ? "changes" : "live");
}

/** The task's QA screenshots, each with the URL the console serves it at and a caption. */
export function screenshotList(task: Pick<Task, "spec" | "screenshots">): Array<{ name: string; url: string; caption: string }> {
  const set = task.screenshots;
  if (!set) return [];
  const base = `/api/hub/tasks/${encodeURIComponent(task.spec.taskId)}/screenshots`;
  return set.files.map((f) => ({
    name: f.name,
    // The commit in the query makes a new QA run's image replace a cached older one.
    url: `${base}/${encodeURIComponent(f.name)}?commit=${set.commit.slice(0, 12)}`,
    caption: `${f.name.replace(/\.(png|jpe?g|gif|webp)$/i, "").replace(/[-_]+/g, " ")} · ${formatBytes(f.bytes)}`,
  }));
}

/** "820 B", "35 KB", "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** "new · " or "deleted · " before a file's line counts; nothing for a change. */
export function fileStatusLabel(status: DiffFile["status"]): string {
  return status === "added" ? "new · " : status === "deleted" ? "deleted · " : "";
}

/** Small diffs open every file; bigger ones leave them for the person to open. */
export function filesOpenByDefault(diff: Pick<TaskDiff, "files">): boolean {
  return diff.files.length <= 3;
}

/**
 * The approve button for these checks (mirrors mergeBlock on the Hub): a plain merge when they passed (or there are none), an
 * explicit "anyway" (force) when they failed, still run or can't be read; none on a conflict.
 */
export function approveAction(checks: ReviewChecks): { label: string; confirm: string; force: boolean; variant: "primary" | "danger" } | undefined {
  const n = checks.pr.number;
  if (checks.mergeable === false) return undefined;
  switch (checks.overall) {
    case "passing":
    case "none":
      return { label: "Approve and merge", confirm: `Merge pull request #${n} into main?`, force: false, variant: "primary" };
    case "pending":
      return { label: "Merge without waiting", confirm: `Checks are still running. Merge pull request #${n} now?`, force: true, variant: "danger" };
    case "failing":
      return { label: "Merge anyway", confirm: `${checksSummary(checks).text}. Merge pull request #${n} anyway?`, force: true, variant: "danger" };
    case "unknown":
      return { label: "Merge anyway", confirm: `The checks can't be read. Merge pull request #${n} anyway?`, force: true, variant: "danger" };
  }
}

/** "3 files · +40 −2" */
export function diffSummary(diff: Pick<TaskDiff, "files">): string {
  const add = diff.files.reduce((n, f) => n + f.additions, 0);
  const del = diff.files.reduce((n, f) => n + f.deletions, 0);
  return `${plural(diff.files.length, "file")} · +${add} −${del}`;
}

export type PatchLineKind = "add" | "del" | "hunk" | "meta" | "context";

/** A file's patch as lines to colour; git's per-file header is left out (the file is named above it). */
export function patchLines(file: Pick<DiffFile, "patch">): Array<{ text: string; kind: PatchLineKind }> {
  if (!file.patch) return [];
  const lines = file.patch.split("\n");
  // A patch without hunks (a mode change) keeps everything after its `diff --git` line.
  const firstHunk = lines.findIndex((l) => l.startsWith("@@"));
  return lines.slice(firstHunk === -1 ? 1 : firstHunk).map((text) => ({
    text,
    kind: text.startsWith("@@") ? "hunk" : text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : text.startsWith("\\") ? "meta" : "context",
  }));
}

/** Text split into plain parts and web links, so the terminal can make links clickable. */
export function linkParts(text: string): Array<{ text: string; url?: string }> {
  const parts: Array<{ text: string; url?: string }> = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    // A sentence's full stop or comma after a link is not part of it.
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: url, url });
    last = m.index + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export interface AgentRow {
  /** `<host> #<desk>`, the agent's name everywhere (console, aso-ui, task crews). */
  name: string;
  slot: number;
  /** What the desk is doing now; absent when idle. */
  now?: { taskId: string; job: "implement" | "test"; title: string };
  /** The last task this agent worked on, other than the current one. */
  last?: { taskId: string; title: string; job: "implement" | "test"; badge: { label: string; tone: Tone } };
}

/**
 * One row per desk of a worker machine, named `<host> #<desk>`. A running job sits at the desk
 * the worker reported; jobs without one (older workers) fill the free desks in order. The last
 * work comes from the tasks' crews, so it survives the worker's restarts.
 */
export function agentRows(node: HubNode, tasks: readonly Task[]): AgentRow[] {
  const host = node.hardware?.hostname;
  if (!host || node.nodeKind !== "worker") return [];
  const slots = node.slots ?? 1;
  const title = (taskId: string) => tasks.find((t) => t.spec.taskId === taskId)?.spec.title ?? taskId;
  const seated = new Map<number, { taskId: string; job: "implement" | "test" }>();
  const unseated: Array<{ taskId: string; job: "implement" | "test" }> = [];
  for (const taskId of runningTasks(node)) {
    const job = node.jobs?.find((j) => j.taskId === taskId);
    const entry = { taskId, job: job?.job ?? ("implement" as const) };
    if (job?.slot && job.slot <= slots && !seated.has(job.slot)) seated.set(job.slot, entry);
    else unseated.push(entry);
  }
  for (let slot = 1; slot <= slots && unseated.length; slot++) if (!seated.has(slot)) seated.set(slot, unseated.shift()!);

  return Array.from({ length: slots }, (_, i) => {
    const slot = i + 1;
    const current = seated.get(slot);
    const worked = tasks
      .flatMap((t) => (t.crew ?? []).filter((m) => m.host === host && m.slot === slot && t.spec.taskId !== current?.taskId).map((m) => ({ t, m })))
      .sort((a, b) => b.m.at.localeCompare(a.m.at))[0];
    return {
      name: `${host} #${slot}`,
      slot,
      ...(current ? { now: { ...current, title: title(current.taskId) } } : {}),
      ...(worked ? { last: { taskId: worked.t.spec.taskId, title: worked.t.spec.title, job: worked.m.job, badge: taskBadge(worked.t) } } : {}),
    };
  });
}

export interface DeskModelChoice {
  /** What `POST /api/desks` takes: a model's spec (`<provider>/<model>`), or `default`. */
  value: string;
  label: string;
  /** The provider it comes from, for grouping in the picker. */
  group?: string;
}

/** A desk's model spec in today's form: older ones (`openai:<model>`, a bare `claude-…`) as the Hub reads them. */
export function canonicalSpec(spec: string): string {
  if (spec.startsWith("openai:")) return `local/${spec.slice("openai:".length)}`;
  if (spec.startsWith("claude-")) return `anthropic/${spec}`;
  return spec;
}

/**
 * The models a desk can be put on: the default first, then each provider's models (grouped by
 * provider), then any model a desk already uses that the Hub no longer lists (so it still shows).
 */
export function deskModelChoices(models: Models, desks?: Pick<Desks, "desks">, machine?: Pick<HubNode, "localModels" | "defaultLocalModel">): DeskModelChoice[] {
  const own = machine?.localModels ?? [];
  const ownDefault = machine?.defaultLocalModel ?? own[0]?.id;
  // On a machine with its own model, "default" means that model (the Hub routes its desks there).
  const choices: DeskModelChoice[] = [{ value: "default", label: ownDefault ? `Default (this machine's own: ${ownDefault})` : `Default (${models.defaultAgent ?? "none"})` }];
  for (const m of own) choices.push({ value: `machine/${m.id}`, label: m.id, group: "This machine's own (free)" });
  for (const m of models.available) choices.push({ value: m.spec, label: m.model, group: m.providerLabel ?? m.providerId ?? m.provider });
  for (const { model } of desks?.desks ?? []) {
    const value = canonicalSpec(model);
    if (!choices.some((c) => c.value === value)) choices.push({ value, label: `${value} (not listed)`, group: "Not listed" });
  }
  return choices;
}

export type ModelRole = "architect" | "reviewer";

/**
 * The models the Architect or the reviewer can be put on: the default first (the Hub's
 * `--model`; for the reviewer, the Architect's), then each provider's models. A machine's own
 * models aren't offered: they serve only their own machine's jobs.
 */
export function roleModelChoices(role: ModelRole, models: Models, desks?: Pick<Desks, "roles" | "architect">): DeskModelChoice[] {
  const fallback = role === "architect" ? "the Hub's --model" : `the Architect's: ${desks?.architect ?? models.architect ?? "none"}`;
  const choices: DeskModelChoice[] = [{ value: "default", label: `Default (${fallback})` }];
  for (const m of models.available) choices.push({ value: m.spec, label: m.model, group: m.providerLabel ?? m.providerId ?? m.provider });
  const own = desks?.roles?.[role];
  if (own && !choices.some((c) => c.value === canonicalSpec(own))) choices.push({ value: canonicalSpec(own), label: `${canonicalSpec(own)} (not listed)`, group: "Not listed" });
  return choices;
}

/** The models a failing task can escalate to: each provider's, plus any on the ladder that aren't listed. Never a machine's own. */
export function escalationChoices(models: Models, desks?: Pick<Desks, "escalation">): DeskModelChoice[] {
  const choices: DeskModelChoice[] = models.available.map((m) => ({ value: m.spec, label: m.model, group: m.providerLabel ?? m.providerId ?? m.provider }));
  for (const step of desks?.escalation?.ladder ?? []) {
    const value = canonicalSpec(step);
    if (!choices.some((c) => c.value === value)) choices.push({ value, label: `${value} (not listed)`, group: "Not listed" });
  }
  return choices;
}

/** Where failing tasks move, in a sentence; undefined for an older Hub that doesn't say. */
export function escalationSummary(desks: Pick<Desks, "escalation" | "escalationSet"> | undefined): string | undefined {
  if (desks?.escalation === undefined) return undefined;
  if (desks.escalation === null) return "Off: every round stays on the desk's model.";
  const { ladder, juniorTries } = desks.escalation;
  const set = desks.escalationSet ?? {};
  const changed = set.ladder !== undefined || set.juniorTries !== undefined ? " Changed while the Hub runs." : "";
  return `After ${juniorTries} ${juniorTries === 1 ? "try" : "tries"} on a desk's model, a task moves to ${ladder.map(canonicalSpec).join(", then ")}.${changed}`;
}

/** Mirrors MAX_ESCALATION_LADDER in @aso/shared: most steps a ladder may have. */
export const MAX_ESCALATION_LADDER = 5;
/** Mirrors MAX_JUNIOR_TRIES in @aso/shared. */
export const MAX_JUNIOR_TRIES = 100;
/** Mirrors DEFAULT_JUNIOR_TRIES in the Hub: the tries before escalating when nothing says otherwise. */
const DEFAULT_JUNIOR_TRIES = 2;

/** What `POST /api/models/escalation` takes: each part a value, or `default` for the Hub's start setting. */
export interface EscalationBody {
  ladder?: string[] | "default";
  juniorTries?: number | "default";
}

/** Both parts back to the Hub's start settings. */
export const ESCALATION_RESET_BODY: EscalationBody = { ladder: "default", juniorTries: "default" };

/** The escalation editor's starting point: the ladder and tries in force (an empty ladder when off). */
export function escalationDraft(desks: Pick<Desks, "escalation"> | undefined): { ladder: string[]; juniorTries: string } {
  const e = desks?.escalation;
  return { ladder: e ? e.ladder.map(canonicalSpec) : [], juniorTries: String(e?.juniorTries ?? DEFAULT_JUNIOR_TRIES) };
}

/** The model a new ladder step starts on: the first choice not on the ladder yet; undefined when it's full or nothing is left. */
export function nextLadderStep(choices: DeskModelChoice[], ladder: string[]): string | undefined {
  if (ladder.length >= MAX_ESCALATION_LADDER) return undefined;
  return choices.find((c) => !ladder.includes(c.value))?.value;
}

/** What `POST /api/models/escalation` takes from the editor, or why it can't be saved. */
export function escalationBody(ladder: string[], juniorTries: string): { body: EscalationBody } | { error: string } {
  if (!ladder.length) return { error: "Add at least one model to the ladder." };
  if (ladder.length > MAX_ESCALATION_LADDER) return { error: `A ladder has at most ${MAX_ESCALATION_LADDER} models.` };
  if (new Set(ladder).size !== ladder.length) return { error: "A model can be on the ladder only once." };
  const tries = Number(juniorTries);
  if (juniorTries.trim() === "" || !Number.isInteger(tries) || tries < 0 || tries > MAX_JUNIOR_TRIES) return { error: `Tries must be a whole number from 0 to ${MAX_JUNIOR_TRIES}.` };
  return { body: { ladder, juniorTries: tries } };
}

/** A role's current choice: its own model's spec, or `default`. */
export function roleModelOf(desks: Pick<Desks, "roles"> | undefined, role: ModelRole): string {
  const own = desks?.roles?.[role];
  return own ? canonicalSpec(own) : "default";
}

/** Choices in picker order: ungrouped first, then a group per provider in the order they come. */
export function choiceGroups(choices: DeskModelChoice[]): Array<{ group?: string; choices: DeskModelChoice[] }> {
  const out: Array<{ group?: string; choices: DeskModelChoice[] }> = [];
  for (const c of choices) {
    const existing = out.find((g) => g.group === c.group);
    if (existing) existing.choices.push(c);
    else out.push({ group: c.group, choices: [c] });
  }
  return out;
}

/** What each provider asks for when added (the Hub's preset table, as the console shows it). */
export const PROVIDER_FORMS: Record<ProviderPreset, { label: string; key: "required" | "optional"; url: boolean; vision: boolean; hint?: string }> = {
  anthropic: { label: "Anthropic (Claude)", key: "required", url: false, vision: false },
  openai: { label: "OpenAI", key: "required", url: false, vision: true },
  openrouter: { label: "OpenRouter", key: "required", url: false, vision: true, hint: "Many providers' models through one key; reports its prices" },
  gemini: { label: "Google Gemini", key: "required", url: false, vision: true },
  groq: { label: "Groq", key: "required", url: false, vision: true },
  mistral: { label: "Mistral", key: "required", url: false, vision: true },
  ollama: { label: "Ollama (a local server)", key: "optional", url: true, vision: true, hint: "e.g. http://avalon:11434/v1" },
  "ollama-cloud": { label: "Ollama Cloud", key: "required", url: false, vision: true, hint: "Ollama's hosted models (a subscription, not priced per token)" },
  custom: { label: "Other OpenAI-compatible API", key: "optional", url: true, vision: true, hint: "Its API root, e.g. http://lab:8000/v1" },
};

/** The provider's name on the Hub: the one given, else the preset's. */
export function providerId(form: { preset: ProviderPreset; name: string }): string {
  return form.name.trim() || form.preset;
}

/** The body for `POST /api/providers` from the form, or why it can't be sent yet. */
export function providerBody(form: { preset: ProviderPreset; key: string; url: string; name: string; vision: boolean }): { body: Record<string, unknown> } | { error: string } {
  const info = PROVIDER_FORMS[form.preset];
  const key = form.key.trim();
  const url = form.url.trim();
  const name = form.name.trim();
  if (info.key === "required" && !key) return { error: `${info.label} needs an API key` };
  if (info.url && !url) return { error: "Give the server's address" };
  if (name && !new RegExp(`^${PROVIDER_ID}$`).test(name)) return { error: "A name is lower-case letters, digits, . _ - (up to 40)" };
  return {
    body: {
      preset: form.preset,
      ...(name ? { id: name } : {}),
      ...(key ? { key } : {}),
      ...(info.url ? { baseUrl: url } : {}),
      ...(form.vision && info.vision ? { vision: true } : {}),
    },
  };
}

/** A provider's line under its name: where it is, where it's set up, and how its model list went. */
export function providerDetail(p: Provider): { detail: string; badge: { label: string; tone: "good" | "bad" } } {
  const parts = [p.baseUrl && PROVIDER_FORMS[p.preset].url ? p.baseUrl : undefined, p.source === "environment" ? "from the Hub's .env" : undefined, p.hasKey ? "key stored" : undefined];
  return {
    detail: [p.error ?? `${p.models ?? 0} models`, ...parts].filter(Boolean).join(" · "),
    badge: p.error ? { label: "Unreachable", tone: "bad" } : { label: "Working", tone: "good" },
  };
}

/** The body for `POST /api/prices` from the form (dollars per million tokens), or what's wrong. */
export function priceBody(form: { model: string; input: string; output: string; cacheRead: string }): { body: { model: string; input: number; output: number; cacheRead?: number } } | { error: string } {
  const model = form.model.trim();
  const usd = (s: string) => Number(s.trim().replace(",", "."));
  const valid = (s: string) => s.trim() !== "" && Number.isFinite(usd(s)) && usd(s) >= 0;
  if (!model) return { error: "Name the model" };
  if (!valid(form.input) || !valid(form.output)) return { error: "Give both prices in dollars per million tokens, e.g. 1.25 and 10" };
  if (form.cacheRead.trim() && !valid(form.cacheRead)) return { error: "The cache read price is dollars per million tokens, e.g. 0.125" };
  return { body: { model, input: usd(form.input), output: usd(form.output), ...(form.cacheRead.trim() ? { cacheRead: usd(form.cacheRead) } : {}) } };
}

/** A price's line: input and output, and cache rates when they differ from the input price. */
export function priceLine(p: Price): string {
  const cache = p.cacheRead !== p.input ? ` · $${p.cacheRead} cached` : "";
  return `$${p.input} in · $${p.output} out${cache}${p.source === "set" ? " · set here" : ""}`;
}

/** Whether a key typed on this page would travel unencrypted: plain HTTP to anything but this machine. */
export function keyTravelsInClear(location: { protocol: string; hostname: string }): boolean {
  return location.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
}

/** A desk's current choice: `default`, or its model's spec. */
export function deskModelOf(desks: Pick<Desks, "desks"> | undefined, host: string, slot: number): string {
  const spec = desks?.desks.find((d) => d.desk === `${host}#${slot}`)?.model;
  return spec ? canonicalSpec(spec) : "default";
}

/** The machine-wide choice: the model every desk shares, or undefined when they differ. */
export function machineModelOf(desks: Pick<Desks, "desks"> | undefined, host: string, slots: number): string | undefined {
  const each = new Set(Array.from({ length: slots }, (_, i) => deskModelOf(desks, host, i + 1)));
  return each.size === 1 ? [...each][0] : undefined;
}

/**
 * Who worked on a task, by agent name (machine and desk): "Built by avalon #2 · tested by
 * canfod #1", or "Building: avalon #3" while it is under way. Earlier agents (before a rework)
 * come first: "Built by avalon #2, then canfod #1".
 */
export function crewLine(task: Pick<Task, "state" | "crew">): string | undefined {
  const crew = task.crew ?? [];
  if (!crew.length) return undefined;
  const names = (job: "implement" | "test") => [...new Set(crew.filter((m) => m.job === job).map((m) => `${m.host} #${m.slot}`))];
  const builders = names("implement");
  const testers = names("test");
  const building = task.state === "assigned" || task.state === "in_progress";
  const parts = [
    builders.length ? `${building ? "Building:" : "Built by"} ${building ? builders.at(-1) : builders.join(", then ")}` : undefined,
    testers.length ? `${task.state === "testing" ? "testing:" : "tested by"} ${task.state === "testing" ? testers.at(-1) : testers.join(", then ")}` : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * The models the task's builds ran on, oldest first and each once in a row, the one on trial
 * marked: "Model: gemini", "Models: terra (on trial), then opus". Undefined before its first build.
 */
export function modelLine(task: Pick<Task, "jobs" | "challenger">): string | undefined {
  const models = (task.jobs ?? []).flatMap((j) => (isBuild(j) && j.model ? [j.model] : []));
  const runs = models.filter((m, i) => m !== models[i - 1]);
  if (!runs.length) return undefined;
  if (task.challenger) runs[0] += " (on trial)";
  return `${runs.length === 1 ? "Model" : "Models"}: ${runs.join(", then ")}`;
}

type TaskJob = NonNullable<Task["jobs"]>[number];
/** A build: not a tests-first task's test writer (the Hub's isBuild in jobs.ts). */
const isBuild = (j: TaskJob) => j.job === "implement" && !j.writesTests;

/**
 * A tests-first task's phase for its page: "Tests first: the test writer (claude-opus-5-5) is
 * writing them" or "Tests first, by claude-opus-5-5: a.test.ts; the builder can't change them".
 */
export function testsFirstLine(task: Pick<Task, "jobs" | "testsFirst">): string | undefined {
  const t = task.testsFirst;
  if (!t) return undefined;
  const writer = [...(task.jobs ?? [])].reverse().find((j) => j.job === "implement" && j.writesTests && j.model)?.model;
  if (t.phase === "tests") return `Tests first: the test writer${writer ? ` (${writer})` : ""} is writing them${t.disputed ? " again, after the builder disputed one" : ""}`;
  return `Tests first${writer ? `, by ${writer}` : ""}: ${t.files.join(", ") || "no files"}; the builder can't change them${t.disputed ? " (back to their writer once)" : ""}`;
}

/** Where a project's QA-approved work goes, for its page. */
export function mergeNote(project: Pick<Project, "pullRequests">): string | undefined {
  const pr = project.pullRequests;
  if (!pr) return undefined;
  return pr.enabled ? `QA-approved work becomes a pull request on ${pr.repo} for you to merge.` : `QA-approved work is merged here: ${pr.reason}.`;
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
  /** Tasks it is working on now (one per busy slot). */
  taskIds: string[];
  detail: string;
  outdated: boolean;
  /** About its aso build, when it is not the Hub's: an update under way, or what to do. */
  updateNote?: string;
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
  const taskIds = runningTasks(n);
  const slots = n.slots ?? 1;
  return {
    nodeId: n.nodeId,
    name,
    taskIds,
    detail: [size, slots > 1 ? `${slots} job slots` : undefined, cpu, build, workerAccess(n)].filter(Boolean).join(" · "),
    outdated: n.outdated === true,
    updateNote: updateNote(n, taskIds.length),
    status: workerStatus(n, taskIds.length, slots),
    actions: workerActions(n, name, taskIds.length),
  };
}

function runningTasks(n: HubNode): string[] {
  return n.currentTaskIds ?? (n.currentTaskId !== null ? [n.currentTaskId] : []);
}

const jobs = (n: number) => (n === 1 ? "job" : "jobs");

/** Whether the worker's pending or running restart is an automatic update. */
const updating = (n: HubNode) => !!n.updateTo;

function workerStatus(n: HubNode, running: number, slots: number): { label: string; tone: Tone } {
  if (n.restart === "sent") return { label: updating(n) ? "Updating" : "Restarting", tone: "active" };
  if (n.restart === "pending") return { label: `${updating(n) ? "Update" : "Restart"} after ${jobs(running)}`, tone: "waiting" };
  if (running > 0) {
    const busy = running < slots ? `${running} of ${slots} jobs` : "Busy";
    return { label: n.draining ? `${busy}, draining` : busy, tone: "active" };
  }
  if (n.draining) return { label: "Drained", tone: "waiting" };
  if (n.outdated) return { label: "Update", tone: "waiting" };
  return { label: "Idle", tone: "muted" };
}

const CANNOT_UPDATE =
  "This worker runs another aso build than the Hub and cannot update itself: it runs from a source checkout, was not started by aso service install, or its build predates automatic updates. Run aso update on it.";

function updateNote(n: HubNode, running: number): string | undefined {
  if (n.updateTo && n.restart === "sent") return `Installing build ${buildOf(n.updateTo)} from the Hub, then restarting.`;
  if (n.updateTo && n.restart === "pending") {
    const when = running === 0 ? "now" : `once ${currentJobs(running)} ${running === 1 ? "is" : "are"} done, and takes no new jobs meanwhile`;
    return `Updates itself to build ${buildOf(n.updateTo)} from the Hub ${when}.`;
  }
  if (!n.outdated) return undefined;
  if (n.updateError) return `The automatic update to build ${buildOf(n.updateError.version)} failed: ${n.updateError.reason}. Run aso update on it.`;
  if (n.updates !== "package") return CANNOT_UPDATE;
  return "This worker runs another aso build than the Hub: run aso update on it.";
}

/** "its current job" / "its 2 current jobs", for `running` > 0. */
function currentJobs(running: number): string {
  return running === 1 ? "its current job" : `its ${running} current jobs`;
}

function restartWhen(running: number): string {
  if (running === 0) return "It restarts now.";
  return `It finishes ${currentJobs(running)} first and takes no new ones meanwhile.`;
}

function workerActions(n: HubNode, name: string, running: number): WorkerActions {
  const allowed = n.actions;
  return {
    drain: allowed?.drain === true,
    resume: allowed?.resume === true,
    restart: allowed?.restart === true,
    resumeLabel: n.restart === "pending" ? (updating(n) ? "Cancel update" : "Cancel restart") : "Resume",
    restartConfirm: `Restart ${name}? ${restartWhen(running)}`,
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
  const deployFailed = p.deploy?.last?.state === "failed";
  if (deployFailed) parts.unshift("deploy failed");
  const idle = p.tasks.total ? `${p.tasks.merged} of ${p.tasks.total} tasks merged` : "No tasks yet";
  return { text: parts.join(" · ") || idle, needsYou: p.plansAwaitingApproval > 0 || questions > 0 || p.tasks.failed > 0 || deployFailed };
}

/** A commit's or a version's short form: `0.1.0+a914b89` → `a914b89`, a sha → its first 7 characters. */
export function shortCommit(versionOrSha: string): string {
  return buildOf(versionOrSha).slice(0, 7);
}

/** A duration the way the console says it: `less than a second`, `42 s`, `3 min 12 s`, `1 h 5 min`. */
export function formatDuration(ms: number): string {
  if (!(ms >= 1000)) return "less than a second"; // also an invalid or negative time
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export interface DeployView {
  label: string;
  tone: Tone;
  detail?: string;
  /** The end of a failed deploy's output, to show collapsed. */
  output?: string;
  /** Whether "Deploy now" may be pressed (not while one runs). */
  canDeploy: boolean;
}

/** A project's deploy section, or undefined when the operator gave it no deploy command. */
export function deployView(deploy: Project["deploy"], now = Date.now()): DeployView | undefined {
  if (!deploy?.configured) return undefined;
  const last: DeployStatus | undefined = deploy.last;
  if (!last) return { label: "No deploy since the Hub started", tone: "muted", canDeploy: true };
  const commit = shortCommit(last.commit);
  const took = last.finishedAt ? formatDuration(Date.parse(last.finishedAt) - Date.parse(last.startedAt)) : undefined;
  if (last.state === "running") return { label: `Deploying ${commit}…`, tone: "active", detail: `started ${timeAgo(last.startedAt, now)}`, canDeploy: false };
  if (last.state === "succeeded") {
    return { label: `Deployed ${commit}`, tone: "good", detail: [last.finishedAt && timeAgo(last.finishedAt, now), took && `took ${took}`].filter(Boolean).join(", "), canDeploy: true };
  }
  return {
    label: `Deploy of ${commit} failed`,
    tone: "bad",
    detail: [last.error, last.finishedAt && timeAgo(last.finishedAt, now)].filter(Boolean).join(" · "),
    output: last.output?.trim() || undefined,
    canDeploy: true,
  };
}

export interface HubUpdateView {
  label: string;
  tone: Tone;
  detail?: string;
  /** Shown as a banner too (a failed update), with its detail there rather than beside the badge. */
  banner: boolean;
}

/** The Hub's own update, for the home page: what it runs and whether it is updating, or why that failed. */
export function hubUpdateView(update: HubUpdate | undefined, now = Date.now()): HubUpdateView | undefined {
  if (!update) return undefined;
  const view = hubUpdateText(update, now);
  return { ...view, banner: update.state === "failed" };
}

function hubUpdateText(update: HubUpdate, now: number): Omit<HubUpdateView, "banner"> {
  const runs = shortCommit(update.current);
  const target = update.target ? shortCommit(update.target) : "a new version";
  const when = update.at ? timeAgo(update.at, now) : undefined;
  switch (update.state) {
    case "off":
      return { label: `Hub ${runs}`, tone: "muted", detail: "doesn't update itself" };
    case "current":
      return { label: `Hub ${runs}`, tone: "good", detail: "up to date" };
    case "building":
      return { label: `Testing update ${target}…`, tone: "active", detail: `Hub runs ${runs}` };
    case "waiting":
      return { label: `Update ${target} ready`, tone: "waiting", detail: "waits until no task, deploy or planning would be interrupted" };
    case "restarting":
      return { label: `Restarting onto ${target}…`, tone: "active" };
    case "updated":
      return { label: `Updated to ${runs}`, tone: "good", detail: when };
    case "failed":
      return { label: update.target ? `Update ${target} failed` : "Update failed", tone: "bad", detail: [update.error, `Hub still runs ${runs}`].filter(Boolean).join(" · ") };
  }
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

/** What a reply means: answering the Architect, asking for changes to a plan, or to a task under review. */
export type ReplyMode = "answer" | "changes" | "review";

/** A plan's reply mode, or undefined when it takes no reply. Mirrors replyMode in @aso/shared (the console doesn't depend on it). */
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
  review: { label: "What should change", placeholder: "What should change? The agent gets this as written, e.g. Make the button bigger and test the empty list", button: "Ask for changes", rows: 3, primary: false },
};

/** Download aso from `base` (the Hub's HTTP address) into a fresh private folder, check it against `sha256` when known, and install it. */
function installCommand(base: string, sha256?: string | null): string {
  // The checksum comes from the Hub over the console's own connection: a package swapped on the
  // way isn't installed. A fresh private folder: no other user can swap the file after the check.
  const check = sha256 ? ` && echo "${sha256}  $d/aso.tgz" | sha256sum -c -` : "";
  return `d=$(mktemp -d) && curl -fo "$d/aso.tgz" ${base}/dist/aso.tgz${check} && npm install -g "$d/aso.tgz"`;
}

/**
 * The one line a new machine runs to install aso and join. `address` is the Hub as the machine
 * reaches it: a host (the Hub's port; no --hub, since the worker finds the Hub on the LAN or over
 * Tailscale, and again when it moves), or the worker gateway's wss:// address (over HTTPS, and the
 * worker keeps that address: there's no discovery on the internet). The CLI builds the same line
 * (`joinCommand` in packages/cli/src/commands/worker-keys.ts): keep them in step.
 */
export function joinCommand(address: string, code: string, sha256?: string | null, port = 7420): string {
  if (/^wss:\/\//i.test(address)) {
    const gateway = address.replace(/\/+$/, "");
    return `${installCommand(gateway.replace(/^wss:/i, "https:"), sha256)} && aso service install --hub ${gateway} --join ${code}`;
  }
  const host = address.includes(":") ? `[${address}]` : address;
  return `${installCommand(`http://${host}:${port}`, sha256)} && aso service install --join ${code}`;
}

/** The invite form on the machines page. */
export interface InviteForm {
  name: string;
  /** It joins from the internet, through the worker gateway. */
  internet: boolean;
  untrusted: boolean;
  projects: string[];
  budget: string;
}

export const EMPTY_INVITE: InviteForm = { name: "", internet: false, untrusted: false, projects: [], budget: "" };

/** The line to show for a join code: through the gateway for an internet invite, else to this console's host. */
export function inviteCommand(opts: { internet: boolean; gatewayUrl?: string; hostname: string; code: string; sha256?: string | null }): { command: string } | { error: string } {
  if (!opts.internet) return { command: joinCommand(opts.hostname, opts.code, opts.sha256) };
  if (!opts.gatewayUrl) {
    return { error: "This Hub has no public gateway address: start it with --gateway-port and --gateway-url (see Workers anywhere in the install guide)." };
  }
  return { command: joinCommand(opts.gatewayUrl, opts.code, opts.sha256) };
}

/** The invite form, as the join-code request's body, or what's wrong with it. */
export function inviteBody(form: InviteForm): { body: Record<string, unknown> } | { error: string } {
  const name = form.name.trim();
  const budget = form.budget.trim().replace(",", ".");
  if (budget && !(Number.isFinite(Number(budget)) && Number(budget) >= 0)) return { error: "The budget is dollars of model calls, e.g. 10" };
  return {
    body: {
      ...(name ? { name } : {}),
      ...(form.untrusted ? { trusted: false } : {}),
      ...(form.projects.length ? { projects: form.projects } : {}),
      ...(budget ? { budgetUsd: Number(budget) } : {}),
    },
  };
}

/** A worker key's state, for the machines page. */
export function workerKeyBadge(k: Pick<WorkerKey, "revokedAt" | "connected" | "lastUsedAt">, now = Date.now()): { label: string; tone: Tone; detail?: string } {
  if (k.revokedAt) return { label: "Revoked", tone: "muted", detail: timeAgo(k.revokedAt, now) };
  if (k.connected) return { label: "Connected", tone: "good" };
  return { label: "Not connected", tone: "waiting", detail: k.lastUsedAt ? `last seen ${timeAgo(k.lastUsedAt, now)}` : "never joined" };
}

/** What a key may do, in words: "Untrusted · aso-ui · $1.20 of $10" (the CLI's is describeScope in hub/src/worker-scope.ts). */
export function workerKeyScope(k: Pick<WorkerKey, "projects" | "trusted" | "budgetUsd" | "spentUsd">): string {
  const spent = k.spentUsd ?? 0;
  const money = k.budgetUsd !== undefined ? `$${spent.toFixed(2)} of $${k.budgetUsd}` : spent ? `$${spent.toFixed(2)} spent` : undefined;
  return [k.trusted === false ? "Untrusted: builds only" : "Trusted", k.projects ? k.projects.join(", ") : "all projects", money].filter(Boolean).join(" · ");
}

/** A machine's track record in words (the CLI's is describeRecord in hub/src/track-record.ts). */
export function workerKeyRecord(track: WorkerKey["track"]): string {
  const n = (k: keyof NonNullable<WorkerKey["track"]>) => track?.[k] ?? 0;
  const ofTotal = (label: string, good: number, bad: number) => (good + bad ? `${label} ${good} of ${good + bad}` : undefined);
  const parts = [
    n("built") ? `${n("built")} build${n("built") === 1 ? "" : "s"}` : undefined,
    ofTotal("QA passed", n("qaPassed"), n("qaFailed")),
    ofTotal("acceptance met", n("accepted"), n("unmet")),
    n("failed") ? `${n("failed")} failed` : undefined,
    n("dropped") ? `${n("dropped")} dropped` : undefined,
    n("tested") ? `${n("tested")} QA run${n("tested") === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No jobs yet";
}

/** How a worker connected: its own key, or the Hub's main token (which can do everything). */
export function workerAccess(node: Pick<HubNode, "workerKey">): string | undefined {
  if (node.workerKey === undefined) return undefined; // an older Hub
  return node.workerKey ? `key "${node.workerKey.name}"` : "the Hub's main token";
}

/** The acceptance check's quality note kinds, as people read them (the Hub's QUALITY_NOTE_LABEL). */
export const QUALITY_NOTE_LABEL: Record<QualityNoteKind, string> = {
  duplication: "Duplicated code",
  "dead-code": "Dead code",
  "misleading-summary": "Summary doesn't match the diff",
  "tests-weakened": "Existing tests weakened or removed",
  other: "Other",
};

/** Quality notes that send the work back (the Hub's BLOCKING_QUALITY_NOTES); the others never block. */
const BLOCKING_QUALITY_NOTES: readonly QualityNoteKind[] = ["tests-weakened"];

const VERDICT_LABEL = { met: "Met", unmet: "Unmet", unclear: "Unclear" } as const;

export interface AcceptanceView {
  headline: string;
  /** `reason`: why it isn't met; met ones need none. */
  criteria: Array<{ criterion: string; verdict: "met" | "unmet" | "unclear"; label: string; reason?: string }>;
  notes: Array<{ label: string; text: string; blocks: boolean }>;
}

/**
 * The acceptance check of the task's current commit, for its page: a headline ("4 of 5 criteria
 * met, 1 unclear (gpt-6.1-sol). …"), each criterion, and the quality notes. Undefined when there is
 * none, or it judged an earlier commit.
 */
export function acceptanceView(task: { acceptance?: Acceptance; commit?: string }): AcceptanceView | undefined {
  const a = task.acceptance;
  if (!a || a.commit !== task.commit) return undefined;
  if (a.result === "checking") return { headline: "Checking the work against its criteria…", criteria: [], notes: [] };
  if (a.result === "undecided") return { headline: `Couldn't decide (${a.reason ?? "no reason"}): check the criteria yourself.`, criteria: [], notes: [] };
  const criteria = a.criteria ?? [];
  const n = (v: "met" | "unmet" | "unclear") => criteria.filter((c) => c.verdict === v).length;
  const extra = [n("unmet") && `${n("unmet")} unmet`, n("unclear") && `${n("unclear")} unclear`].filter(Boolean).join(", ");
  const counts = `${n("met")} of ${criteria.length} criteria met${extra ? `, ${extra}` : ""}`;
  return {
    headline: `${counts}${a.model ? ` (${a.model})` : ""}.${a.summary ? ` ${a.summary}` : ""}`,
    criteria: criteria.map((c) => ({ criterion: c.criterion, verdict: c.verdict, label: VERDICT_LABEL[c.verdict], ...(c.verdict === "met" || !c.reason ? {} : { reason: c.reason }) })),
    notes: (a.qualityNotes ?? []).map((q) => ({ label: QUALITY_NOTE_LABEL[q.kind] ?? q.kind, text: q.file ? `${q.file}: ${q.note}` : q.note, blocks: BLOCKING_QUALITY_NOTES.includes(q.kind) })),
  };
}

/** The groupings the track records page offers, with their labels. */
export const TRACK_RECORD_GROUPS: ReadonlyArray<{ by: TrackRecordKey; label: string }> = [
  { by: "model", label: "Models" },
  { by: "host", label: "Machines" },
  { by: "desk", label: "Desks" },
  { by: "role", label: "Roles" },
  { by: "project", label: "Projects" },
  { by: "level", label: "Task levels" },
];

export function trackRecordGroupLabel(by: TrackRecordKey): string {
  return TRACK_RECORD_GROUPS.find((g) => g.by === by)?.label ?? by;
}

/** The Hub path for the track records page. */
export function trackRecordsPath(by: TrackRecordKey, filters: TrackRecordFilters = {}): string {
  const q = new URLSearchParams({ by });
  for (const k of ["project", "role", "model", "since"] as const) if (filters[k]) q.set(k, filters[k]);
  return `track-records?${q.toString()}`;
}

/** What the track records page narrows to; empty: everything. */
export interface TrackRecordFilters {
  project?: string;
  role?: string;
  /** A model's name as the records keep it: only its work. */
  model?: string;
  since?: string;
}

/** The roles a task can have, for the track records' role filter (the Hub's worker roles). */
export const TASK_ROLES = ["frontend", "backend", "qa", "devops"] as const;

/** The track records' periods: the last N days, or everything. */
export const TRACK_RECORD_PERIODS = [
  { days: 0, label: "All time" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
] as const;

/** The `since` of the last `days` days, as a date (so it stays the same all day); undefined: all time. */
export function sinceDaysAgo(days: number, now: Date): string | undefined {
  return days > 0 ? new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10) : undefined;
}

/** "label 3 of 4", or nothing when there were none. */
export function goodOfTotal(label: string, good: number, bad: number): string | undefined {
  return good + bad ? `${label} ${good} of ${good + bad}` : undefined;
}

/** "2 approved, 1 rejected": the non-zero counts with their labels, or "". */
export function counted(pairs: ReadonlyArray<readonly [number, string]>): string {
  return pairs
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}`)
    .join(", ");
}

/** The tasks part: "2 tasks finished (1 first try, 1 taken over)", "no task finished yet", or nothing without builds. */
export function finishedSummary(tasks: TrackRecordRow["tasks"], builds: number): string | undefined {
  if (!tasks.finished) return builds ? "no task finished yet" : undefined;
  const how = counted([
    [tasks.firstTry, "first try"],
    [tasks.tookOver, "taken over"],
  ]);
  return `${plural(tasks.finished, "task")} finished (${how || "after rework"})`;
}

/**
 * The tasks that started here, all in: "3 tasks started here, 2 finished: $0.75 a finished task,
 * escalations and failures included", or nothing.
 */
export function startedSummary(s: TrackRecordRow["started"]): string | undefined {
  if (!s?.settled) return undefined;
  const counts = `${plural(s.settled, "task")} started here, ${s.finished} finished`;
  // None finished: no cost per finished task, so what was spent.
  if (s.costPerFinishedUsd === undefined) return `${counts}, ${formatUsd(s.costUsd)} spent`;
  return `${counts}: ${formatUsd(s.costPerFinishedUsd)} a finished task, escalations and failures included`;
}

/**
 * A track record in a line: "2 tasks finished (1 first try, 1 taken over) · 5 builds · QA passed
 * 3 of 4 · … · $0.50 on its builds · 3 tasks started here, 2 finished: $0.75 a finished task, …".
 */
export function trackRecordLine(r: TrackRecordRow): string {
  const b = r.builds;
  const q = r.qaRuns;
  const parts = [
    finishedSummary(r.tasks, b.jobs),
    b.jobs ? plural(b.jobs, "build") : undefined,
    goodOfTotal("QA passed", b.qaPassed, b.qaFailed),
    goodOfTotal("acceptance met", b.accepted, b.unmet),
    b.qualityNotes ? plural(b.qualityNotes, "quality note") : undefined,
    b.outOfTurns ? `${b.outOfTurns} out of turns` : undefined,
    b.failed ? `${b.failed} failed` : undefined,
    b.dropped ? `${b.dropped} dropped` : undefined,
    q.runs ? `${plural(q.runs, "QA run")}${q.passed + q.failed ? ` (${q.passed} of ${q.passed + q.failed} passed)` : ""}` : undefined,
    r.costUsd || b.jobs ? `${formatUsd(r.costUsd)} on its builds` : undefined,
    startedSummary(r.started),
    plansSummary(r.plans),
    reviewsSummary(r.reviews),
  ];
  return parts.filter(Boolean).join(" · ");
}

/** "3 plans (2 approved, 1 rejected; questions first in 2), $1.60", or nothing. */
export function plansSummary(p: TrackRecordRow["plans"]): string | undefined {
  if (!p.planned) return undefined;
  const outcome = counted([
    [p.approved, "approved"],
    [p.rejected, "rejected"],
    [p.failed, "failed"],
  ]);
  const asked = p.withQuestions ? `questions first in ${p.withQuestions}` : "";
  const details = [outcome, asked].filter(Boolean).join("; ");
  return `${plural(p.planned, "plan")}${details ? ` (${details})` : ""}, ${formatUsd(p.costUsd)}`;
}

/** "9 acceptance checks (7 met, 1 unmet, 1 undecided), $0.45", or nothing. */
export function reviewsSummary(r: TrackRecordRow["reviews"]): string | undefined {
  if (!r.checks) return undefined;
  const verdicts = counted([
    [r.met, r.overturned ? `met (${r.overturned} overturned later)` : "met"],
    [r.unmet, "unmet"],
    [r.undecided, "undecided"],
  ]);
  return `${plural(r.checks, "acceptance check")}${verdicts ? ` (${verdicts})` : ""}, ${formatUsd(r.costUsd)}`;
}

/** Mirrors SUGGESTION_ROLE_LABEL in @aso/shared. */
const SUGGESTION_ROLE: Record<SuggestionRole, string> = { desks: "Desks", reviewer: "Reviewer", architect: "Architect" };

/** A suggestion's title: "Reviewer: gpt-6.1-sol instead of claude-opus-5-5". */
export function suggestionTitle(s: ModelSuggestion): string {
  return `${SUGGESTION_ROLE[s.role]}: ${s.suggested.model} instead of ${s.current.model}`;
}

/** A note on a role without a suggestion: "Desks: gemini: 5 of 10 settled tasks needed to compare it." */
export function suggestionNote(n: ModelSuggestions["notes"][number]): string {
  return `${SUGGESTION_ROLE[n.role]}: ${n.text}`;
}

/** The console requests that apply a suggestion, from what the Hub says applies it. */
export function suggestionRequests(s: ModelSuggestion): Array<{ path: string; body: Record<string, string> }> {
  return s.apply.map((a): { path: string; body: Record<string, string> } =>
    a.kind === "desk" ? { path: "desks", body: { target: a.target, model: a.model } } : { path: "models/roles", body: { role: a.target, model: a.model } },
  );
}

/** Mirror MAX_CHALLENGER_SHARE and DEFAULT_CHALLENGER_SHARE (as percentages), DEFAULT_CHALLENGER_BUDGET_USD and ChallengerBodySchema's budget bounds in @aso/shared. */
export const MAX_TRIAL_SHARE_PERCENT = 50;
export const DEFAULT_TRIAL_SHARE_PERCENT = 10;
export const DEFAULT_TRIAL_BUDGET_USD: Record<ChallengerRole, number> = { desks: 20, reviewer: 5 };

/** How many tasks pass, on average, before a trial taking `sharePercent` has the `needed` samples: "about 100 tasks". */
export function trialLength(sharePercent: number, needed: number): string {
  return `about ${Math.ceil(needed / (sharePercent / 100))} tasks`;
}
const TRIAL_BUDGET_USD = { min: 0.5, max: 1000 };

/** What `POST /api/models/challengers` takes to start a trial, or why it can't start. */
export function trialBody(role: ChallengerRole, model: string, sharePercent: string, budgetUsd: string): { body: { role: ChallengerRole; model: string; share: number; budgetUsd: number } } | { error: string } {
  if (!model) return { error: "Choose a model to try." };
  const share = Number(sharePercent);
  if (!Number.isInteger(share) || share < 1 || share > MAX_TRIAL_SHARE_PERCENT) return { error: `The share must be a whole percentage from 1 to ${MAX_TRIAL_SHARE_PERCENT}.` };
  const budget = Number(budgetUsd);
  if (!Number.isFinite(budget) || budget < TRIAL_BUDGET_USD.min || budget > TRIAL_BUDGET_USD.max) {
    return { error: `The budget must be from $${TRIAL_BUDGET_USD.min.toFixed(2)} to $${TRIAL_BUDGET_USD.max}.` };
  }
  return { body: { role, model, share: share / 100, budgetUsd: budget } };
}

/** A pool member in a line: "openai/gpt-6.1-terra: 30%, 3 of 10 samples, $4.20 of $20.00". */
export function poolMemberLine(t: Trial): string {
  return `${t.model}: ${Math.round(t.share * 100)}%, ${t.samples} of ${t.needed} samples, ${formatUsd(t.spentUsd)} of ${formatUsd(t.budgetUsd)}${t.ended ? `, ${t.ended}` : ""}`;
}

/** The candidates typed in (comma-separated) as `POST /api/tuning` takes them; "" clears the queue. */
export function candidatesBody(role: ChallengerRole, typed: string): { role: ChallengerRole; candidates: string[] } {
  return { role, candidates: typed.split(",").map((m) => m.trim()).filter(Boolean) };
}

/** The latest `n` tuning changes, newest first. */
export function recentChanges<T>(log: readonly T[], n: number): T[] {
  return log.slice(-n).reverse();
}
