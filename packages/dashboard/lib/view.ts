import type {
  Desks,
  Models, Price, Provider, ProviderPreset, CheckState, DeployStatus, DiffFile, HubNode, HubUpdate, WorkerKey, Plan, PlannedTask, Project, ReviewChecks, Task, TaskDiff, TaskState, TranscriptEntry } from "./types.ts";

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

/** The task page's tab: the person's choice, else the changes while a review waits, else the live view. */
export function currentTab(chosen: TaskTab | undefined, task: Pick<Task, "state" | "review" | "commit" | "screenshots">): TaskTab {
  if (chosen === "changes" && !hasChanges(task)) return "live"; // e.g. the work went back to an agent
  if (chosen === "screenshots" && !task.screenshots?.files.length) return "live"; // a later QA run took none
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
