import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatUsd,
  homeView,
  isLive,
  isQuiet,
  planProgress,
  previewBody,
  projectNameProblem,
  projectSummary,
  planBadge,
  planThread,
  replyMode,
  taskActions,
  taskBadge,
  terminalLines,
  timeAgo,
  workerView,
  workerViews,
  buildOf,
  mergeNote,
  linkParts,
  reviewLink,
  reviewView,
} from "../lib/view.ts";
import type { HubNode, Plan, PlannedTask, Project, Task, TranscriptEntry } from "../lib/types.ts";

const task = (id: string, state: Task["state"], extra: Partial<Task> = {}): Task => ({
  project: "shop",
  spec: { taskId: id, role: "backend", kind: "feature", title: `Task ${id}`, description: "", acceptanceCriteria: [], dependsOn: [] },
  state,
  reworkRound: 0,
  llm: { calls: 0, costUsd: 0 },
  filesTouched: [],
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  history: [],
  ...extra,
});

const plan = (id: string, state: Plan["state"], extra: Partial<Plan> = {}): Plan => ({
  planId: id,
  project: "blog",
  requirement: `Build ${id}\nmore detail`,
  state,
  llm: { calls: 0, costUsd: 0 },
  createdAt: "2026-10-14T10:00:00.000Z",
  updatedAt: "2026-10-14T10:00:00.000Z",
  history: [],
  ...extra,
});

describe("pull request reviews", () => {
  const pr = { number: 7, url: "https://github.com/me/shop/pull/7" };

  it("asks for a review under Needs you, with the pull request on the task page", () => {
    const v = homeView([task("r", "awaiting_review", { review: { pr, rounds: 0 } }), task("w", "in_progress")], []);
    assert.deepEqual(
      v.attention.map((a) => [a.id, a.reason, a.badge.label, a.href]),
      [["r", "Pull request #7 is ready for your review on GitHub", "Review?", "/tasks/r"]],
    );
    assert.deepEqual(v.running.map((t) => t.spec.taskId), ["w"], "not listed as running too");
    assert.deepEqual(taskBadge(task("r", "awaiting_review")), { label: "Review", tone: "waiting" });
    assert.deepEqual(taskActions(task("r", "awaiting_review")), { retry: false, cancel: true });
  });

  it("words each stage of the pull request", () => {
    const view = (state: Task["state"], review?: Task["review"]) => reviewView(task("t", state, { review }));
    assert.equal(view("in_progress"), undefined, "no pull requests on this Hub");
    assert.deepEqual(view("awaiting_review", { rounds: 0, error: "HTTP 502" }), { text: "Opening a pull request on GitHub", error: "HTTP 502" });
    assert.deepEqual(view("awaiting_review", { pr, rounds: 2 }), { text: "Pull request #7 is ready for your review on GitHub (after 2 rounds of changes)", url: pr.url, error: undefined });
    assert.deepEqual(view("in_progress", { pr, rounds: 1 }), { text: "Changes requested on pull request #7; an agent is on it (after 1 round of changes)", url: pr.url });
    assert.deepEqual(view("merged", { pr, rounds: 0 }), { text: "Merged on GitHub as pull request #7", url: pr.url });
    assert.deepEqual(view("cancelled", { pr, rounds: 0 }), { text: "Pull request #7 was closed", url: pr.url });
    assert.equal(view("in_progress", { rounds: 0 }), undefined, "no pull request yet, nothing to say");
  });

  it("puts the pull request one tap away on the task page", () => {
    assert.deepEqual(reviewLink(task("t", "awaiting_review", { review: { pr, rounds: 0 } })), { label: "Review pull request #7 on GitHub", url: pr.url, primary: true });
    assert.deepEqual(reviewLink(task("t", "merged", { review: { pr, rounds: 0 } })), { label: "Pull request #7 on GitHub", url: pr.url, primary: false });
    assert.equal(reviewLink(task("t", "awaiting_review", { review: { rounds: 0 } })), undefined, "not opened yet");
    assert.equal(reviewLink(task("t", "in_progress")), undefined);
  });

  it("makes links in the terminal clickable, without the full stop after them", () => {
    assert.deepEqual(linkParts("pull request #1 opened for review: https://github.com/me/shop/pull/1."), [
      { text: "pull request #1 opened for review: " },
      { text: "https://github.com/me/shop/pull/1", url: "https://github.com/me/shop/pull/1" },
      { text: "." },
    ]);
    assert.deepEqual(linkParts("see (https://a.example/x) and http://b.example"), [
      { text: "see (" },
      { text: "https://a.example/x", url: "https://a.example/x" },
      { text: ") and " },
      { text: "http://b.example", url: "http://b.example" },
    ]);
    assert.deepEqual(linkParts("no links here"), [{ text: "no links here" }]);
    assert.deepEqual(linkParts(""), []);
  });

  it("says where a project's work goes", () => {
    assert.equal(mergeNote({ pullRequests: { enabled: true, repo: "me/shop" } }), "QA-approved work becomes a pull request on me/shop for you to merge.");
    assert.equal(mergeNote({ pullRequests: { enabled: false, reason: "no GitHub token (ASO_GIT_TOKEN) for opening pull requests" } }), "QA-approved work is merged here: no GitHub token (ASO_GIT_TOKEN) for opening pull requests.");
    assert.equal(mergeNote({}), undefined, "a Hub from before pull requests");
  });
});

describe("home view", () => {
  it("puts plans awaiting approval and failures first, and sorts the rest", () => {
    const tasks = [
      task("a", "in_progress"),
      task("b", "failed", { detail: "QA failed 3 times" }),
      task("c", "pending"),
      task("d", "merged", { updatedAt: "2026-10-14T11:00:00.000Z" }),
      task("e", "cancelled", { updatedAt: "2026-10-14T12:00:00.000Z" }),
      task("f", "awaiting_qa"),
    ];
    const plans = [plan("p1", "proposed"), plan("p2", "failed", { error: "Architect crashed" }), plan("p3", "planning"), plan("p4", "rejected")];
    const v = homeView(tasks, plans);
    assert.deepEqual(
      v.attention.map((a) => [a.kind, a.id, a.project, a.badge.label]),
      [["plan", "p1", "blog", "Approve?"], ["task", "b", "shop", "Failed"], ["plan", "p2", "blog", "Failed"]],
    );
    assert.equal(v.attention[0].title, "Build p1", "first line of the requirement");
    assert.equal(v.attention[1].reason, "QA failed 3 times");
    assert.deepEqual(v.running.map((t) => t.spec.taskId), ["a", "f"]);
    assert.deepEqual(v.queued.map((t) => t.spec.taskId), ["c"]);
    assert.deepEqual(v.done.map((t) => t.spec.taskId), ["e", "d"], "newest first");
    assert.deepEqual(v.activePlans.map((p) => p.planId), ["p3"]);
  });

  it("keeps an approved plan active until all its tasks merged", () => {
    const p = plan("p", "approved", { taskIds: { api: "api-1", ui: "ui-1" } });
    const open = homeView([task("api-1", "merged"), task("ui-1", "in_progress")], [p]);
    assert.equal(open.activePlans.length, 1);
    const finished = homeView([task("api-1", "merged"), task("ui-1", "merged")], [p]);
    assert.equal(finished.activePlans.length, 0);
    assert.deepEqual(planProgress(p, [task("api-1", "merged"), task("ui-1", "failed")]), { merged: 1, failed: 1, total: 2 });
    assert.deepEqual(planProgress(plan("x", "proposed"), []), { merged: 0, failed: 0, total: 0 });
  });
});

describe("what a person can do", () => {
  it("offers retry for failed or cancelled tasks and cancel for unfinished ones", () => {
    const states = ["pending", "in_progress", "merging", "merged", "failed", "cancelled"] as const;
    assert.deepEqual(
      states.map((state) => [state, isLive(state), taskActions({ state })]),
      [
        ["pending", true, { retry: false, cancel: true }],
        ["in_progress", true, { retry: false, cancel: true }],
        ["merging", true, { retry: false, cancel: false }],
        ["merged", false, { retry: false, cancel: false }],
        ["failed", false, { retry: true, cancel: false }],
        ["cancelled", false, { retry: true, cancel: false }],
      ],
    );
  });
});

describe("badges", () => {
  it("explains why a task is not moving", () => {
    assert.deepEqual(taskBadge({ state: "in_progress", detachedAt: 1 }), { label: "Worker offline", tone: "waiting" });
    assert.deepEqual(taskBadge({ state: "pending", waitingReason: "blocked: dependency a failed" }), { label: "Blocked", tone: "bad" });
    assert.deepEqual(taskBadge({ state: "pending", waitingReason: "waiting for a to be merged" }), { label: "Waiting", tone: "muted" });
    assert.deepEqual(taskBadge({ state: "pending", waitingReason: "no idle node with role backend" }), { label: "Queued", tone: "waiting" });
    assert.deepEqual(taskBadge({ state: "merged" }), { label: "Merged", tone: "good" });
  });
});

describe("terminal lines", () => {
  const at = "2026-10-14T10:00:00.000Z";
  const entries: TranscriptEntry[] = [
    { seq: 0, at, kind: "text", text: "Let me run the tests." },
    { seq: 1, at, kind: "call", id: "t1", name: "run_command", input: { argv: ["npm", "test"] } },
    { seq: 2, at, kind: "result", id: "t1", name: "run_command", content: "exit code 1 (2.0s)\nFAIL a.test.ts\nexpected 1", isError: true },
    { seq: 3, at, kind: "call", id: "t2", name: "read_file", input: { path: "src/a.ts" } },
    { seq: 4, at, kind: "result", id: "t2", name: "read_file", content: "1\tconst a = 1;", isError: false },
    { seq: 5, at, kind: "call", id: "t3", name: "edit_file", input: { path: "src/a.ts", old_string: "1", new_string: "2" } },
    { seq: 6, at, kind: "result", id: "t3", name: "edit_file", content: "no match for old_string", isError: true },
    { seq: 7, at, kind: "call", id: "t4", name: "request_dependencies", input: { packages: [{ name: "zod" }, { name: "vitest", dev: true }] } },
    { seq: 8, at, kind: "event", text: "pushed abc12345" },
    { seq: 9, at, kind: "qa", outcome: "fail", summary: "1 test failed", output: "trace" },
  ];

  it("shows commands like a shell and file tools like a log", () => {
    const lines = terminalLines(entries, { showQuiet: true });
    assert.deepEqual(
      lines.map((l) => [l.style, l.text]),
      [
        ["say", "Let me run the tests."],
        ["command", "$ npm test"],
        ["error", "exit code 1 (2.0s)"],
        ["tool", "read src/a.ts"],
        ["output", "read_file ok"],
        ["tool", "edit src/a.ts"],
        ["error", "no match for old_string"],
        ["tool", "add packages zod, vitest"],
        ["event", "pushed abc12345"],
        ["fail", "QA failed: 1 test failed"],
      ],
    );
    assert.equal(lines[2].body, "FAIL a.test.ts\nexpected 1", "command output under the status line");
    assert.equal(lines[4].body, "1\tconst a = 1;");
    assert.equal(lines[5].body, "2", "edits show the new text");
    assert.equal(lines[9].body, "trace");
  });

  it("treats successful results of quiet tools as noise, never errors or commands", () => {
    assert.deepEqual(entries.map((e) => isQuiet(e)), [false, false, false, false, true, false, false, false, false, false]);
  });

  it("leaves quiet results out by default", () => {
    const lines = terminalLines(entries);
    assert.equal(lines.length, entries.length - 1);
    assert.ok(!lines.some((l) => l.seq === 4), "the successful read_file result");
    assert.ok(lines.some((l) => l.seq === 6), "errors always stay");
  });

  it("previews long output by its last lines", () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const short = previewBody(body, false, 12);
    assert.equal(short.truncated, true);
    assert.equal(short.lines, 30);
    assert.equal(short.text!.split("\n")[0], "line 18");
    assert.equal(previewBody(body, true, 12).text, body);
    assert.deepEqual(previewBody("a\nb", false, 12), { text: "a\nb", lines: 2, truncated: false });
    assert.deepEqual(previewBody(undefined, false, 12), { lines: 0, truncated: false });
  });
});

describe("formatting", () => {
  it("formats money and time for small screens", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(0.004), "<$0.01");
    assert.equal(formatUsd(3.456), "$3.46");
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    assert.equal(timeAgo("2026-10-14T11:59:30.000Z", now), "just now");
    assert.equal(timeAgo("2026-10-14T11:50:00.000Z", now), "10 min ago");
    assert.equal(timeAgo("2026-10-14T09:00:00.000Z", now), "3 h ago");
    assert.equal(timeAgo("2026-10-12T12:00:00.000Z", now), "2 d ago");
    assert.equal(timeAgo("2026-10-14T12:05:00.000Z", now), "just now", "clock skew never goes negative");
  });

  it("lists workers only, with what they are doing", () => {
    const nodes: HubNode[] = [
      { nodeId: "architect-1", nodeKind: "architect", heartbeat: null, currentTaskId: null, lastSeenAt: "" },
      {
        nodeId: "avalon-1",
        nodeKind: "worker",
        hardware: { hostname: "avalon", cpu: { logicalCores: 12 }, memory: { totalBytes: 32 * 1024 ** 3 } },
        heartbeat: { memoryAvailableBytes: 1, cpuLoadPercent: 37.4 },
        currentTaskId: "api",
        lastSeenAt: "",
        supervisor: "systemd",
      },
    ];
    const [w, ...rest] = workerViews(nodes);
    assert.equal(rest.length, 0);
    assert.deepEqual(
      { nodeId: w.nodeId, name: w.name, taskIds: w.taskIds, detail: w.detail, status: w.status },
      { nodeId: "avalon-1", name: "avalon", taskIds: ["api"], detail: "12 cores, 32 GiB · CPU 37%", status: { label: "Busy", tone: "active" } },
    );
  });

  it("shows each worker's build and whether it needs updating", () => {
    const node = (version: string | undefined, outdated?: boolean): HubNode => ({ nodeId: "w", nodeKind: "worker", heartbeat: null, currentTaskId: null, lastSeenAt: "", version, outdated });
    assert.deepEqual(
      workerViews([node("0.1.0+e422cd7", false), node("0.1.0", true), node(undefined)]).map((w) => [w.detail, w.status.label]),
      [["build e422cd7", "Idle"], ["build 0.1.0", "Update"], ["", "Idle"]],
    );
    assert.equal(buildOf("0.1.0+abc-dirty"), "abc-dirty");
  });

  it("shows the worker buttons the Hub allows, with labels for the current state", () => {
    const allow = (drain: boolean, resume: boolean, restart: boolean, why: Record<string, string> = {}) => ({ drain, resume, restart, why });
    const base: HubNode = { nodeId: "w", nodeKind: "worker", heartbeat: null, currentTaskId: null, lastSeenAt: "", hardware: { hostname: "avalon", cpu: { logicalCores: 1 }, memory: { totalBytes: 1 } } };
    const view = (n: Partial<HubNode>) => workerView({ ...base, ...n });

    const idle = view({ actions: allow(true, false, true), outdated: true });
    assert.deepEqual([idle.status.label, idle.actions.drain, idle.actions.resume, idle.actions.restart], ["Update", true, false, true]);
    assert.equal(idle.actions.restartConfirm, "Restart avalon? It restarts now.");

    const busy = view({ currentTaskId: "t", actions: allow(true, false, true) });
    assert.match(busy.actions.restartConfirm, /finishes its current job first/);

    assert.deepEqual([view({ draining: true }).status.label, view({ draining: true, currentTaskId: "t" }).status.label], ["Drained", "Busy, draining"]);
    const pending = view({ draining: true, restart: "pending", currentTaskId: "t", actions: allow(false, true, false) });
    assert.deepEqual([pending.status.label, pending.actions.resumeLabel], ["Restart after job", "Cancel restart"]);
    assert.equal(view({ draining: true, actions: allow(false, true, true) }).actions.resumeLabel, "Resume");
    assert.equal(view({ draining: true, restart: "sent" }).status.label, "Restarting");

    const manual = view({ actions: allow(true, false, false, { restart: "started by hand: run aso service install" }) });
    assert.equal(manual.actions.restart, false);
    assert.match(manual.actions.restartNote!, /aso service install/);

    const slots = (ids: string[], extra: Partial<HubNode> = {}) => view({ slots: 4, currentTaskIds: ids, currentTaskId: ids[0] ?? null, ...extra });
    assert.deepEqual(
      [slots([]), slots(["a"]), slots(["a", "b", "c", "d"]), slots(["a", "b"], { draining: true })].map((w) => w.status.label),
      ["Idle", "1 of 4 jobs", "Busy", "2 of 4 jobs, draining"],
    );
    assert.equal(slots(["a", "b"], { draining: true, restart: "pending" }).status.label, "Restart after jobs");
    assert.match(slots(["a", "b"], { actions: allow(true, false, true) }).actions.restartConfirm, /its 2 current jobs first/);
    assert.deepEqual(slots(["a", "b"]).taskIds, ["a", "b"]);
    assert.match(slots([]).detail, /4 job slots/);

    const oldHub = view({}).actions;
    assert.deepEqual([oldHub.drain, oldHub.resume, oldHub.restart, oldHub.restartNote], [false, false, false, undefined], "a Hub without actions gets no buttons");
  });

  it("explains a worker's update: under way, waiting for jobs, failed, or by hand", () => {
    const base: HubNode = { nodeId: "w", nodeKind: "worker", heartbeat: null, currentTaskId: null, lastSeenAt: "", version: "0.1.0+old", outdated: true };
    const view = (n: Partial<HubNode>) => workerView({ ...base, ...n });
    const updating = { updates: "package" as const, updateTo: "0.1.0+f262197", draining: true };

    const sent = view({ ...updating, restart: "sent" });
    assert.deepEqual([sent.status.label, sent.updateNote], ["Updating", "Installing build f262197 from the Hub, then restarting."]);
    const waiting = view({ ...updating, restart: "pending", currentTaskIds: ["a", "b"], currentTaskId: "a", slots: 4 });
    assert.equal(waiting.status.label, "Update after jobs");
    assert.equal(waiting.updateNote, "Updates itself to build f262197 from the Hub once its 2 current jobs are done, and takes no new jobs meanwhile.");
    assert.equal(waiting.actions.resumeLabel, "Cancel update");
    assert.match(view({ ...updating, restart: "pending", currentTaskId: "a" }).updateNote!, /once its current job is done/);
    assert.match(view({ ...updating, restart: "pending" }).updateNote!, /from the Hub now\.$/);

    const failed = view({ updates: "package", updateError: { version: "0.1.0+f262197", reason: "npm install exited with code 1" } });
    assert.deepEqual([failed.status.label, failed.updateNote], ["Update", "The automatic update to build f262197 failed: npm install exited with code 1. Run aso update on it."]);
    assert.match(view({}).updateNote!, /cannot update itself: it runs from a source checkout.*predates automatic updates\. Run aso update on it\.$/);
    assert.equal(view({ updates: "package" }).updateNote, "This worker runs another aso build than the Hub: run aso update on it.");
    assert.equal(view({ outdated: false, updateError: { version: "x", reason: "y" } }).updateNote, undefined, "current: nothing to say");
  });
});

describe("projects", () => {
  it("checks a new project's name like the Hub does", () => {
    assert.equal(projectNameProblem("my-app"), undefined);
    assert.equal(projectNameProblem("app_2"), undefined);
    assert.match(projectNameProblem("")!, /name/);
    assert.match(projectNameProblem("-app")!, /Start with/);
    assert.match(projectNameProblem("My App")!, /lowercase/);
    assert.match(projectNameProblem("../x")!, /Start with/);
    assert.match(projectNameProblem("a.b")!, /lowercase letters, digits/);
    assert.match(projectNameProblem("x".repeat(65))!, /64/);
  });

  it("sums a project up in one line, flagging what needs you", () => {
    const p = (tasks: Partial<Project["tasks"]>, approve = 0): Project => ({
      id: "shop",
      dir: "/p/shop",
      tasks: { total: 0, running: 0, queued: 0, failed: 0, merged: 0, ...tasks },
      plansAwaitingApproval: approve,
    });
    assert.deepEqual(projectSummary(p({})), { text: "No tasks yet", needsYou: false });
    assert.deepEqual(projectSummary(p({ total: 3, merged: 3 })), { text: "3 of 3 tasks merged", needsYou: false });
    assert.deepEqual(projectSummary(p({ total: 4, running: 1, queued: 2, failed: 1 }, 1)), {
      text: "1 to approve · 1 failed · 1 running · 2 queued",
      needsYou: true,
    });
  });
});

describe("plan conversation", () => {
  const proposal: PlannedTask = { key: "api", role: "backend", kind: "feature", title: "API", description: "d", acceptanceCriteria: [], dependsOn: [] };
  const dialogue: NonNullable<Plan["dialogue"]> = [
    { kind: "questions", at: "2026-10-14T10:01:00.000Z", questions: ["Which DB?"], context: "Empty repo" },
    { kind: "reply", at: "2026-10-14T10:02:00.000Z", text: "SQLite" },
    { kind: "proposal", at: "2026-10-14T10:03:00.000Z", summary: "One task", tasks: [proposal] },
    { kind: "reply", at: "2026-10-14T10:04:00.000Z", text: "Split it" },
  ];

  it("shows the requirement, then the conversation in order", () => {
    const items = planThread(plan("p", "planning", { dialogue }));
    assert.deepEqual(items.map((i) => `${i.who}:${i.kind}`), ["you:requirement", "architect:questions", "you:reply", "architect:earlier-proposal", "you:reply"]);
    assert.deepEqual(items[1], { who: "architect", kind: "questions", questions: ["Which DB?"], context: "Empty repo", at: "2026-10-14T10:01:00.000Z" });
    assert.equal(planThread(plan("p", "pending")).length, 1, "a new plan is just its requirement");
  });

  it("offers answering questions or asking for changes, until the reply limit", () => {
    assert.equal(replyMode(plan("p", "awaiting_input")), "answer");
    assert.equal(replyMode(plan("p", "proposed")), "changes");
    for (const s of ["pending", "planning", "approved", "rejected", "failed"] as const) assert.equal(replyMode(plan("p", s)), undefined, s);
    const ten = Array.from({ length: 10 }, (_, i) => ({ kind: "reply" as const, at: "", text: `r${i}` }));
    assert.equal(replyMode(plan("p", "proposed", { dialogue: ten })), undefined, "the Hub refuses an 11th reply");
  });

  it("puts questions under Needs you and on the project", () => {
    assert.deepEqual(planBadge({ state: "awaiting_input" }), { label: "Has questions", tone: "waiting" });
    const view = homeView([], [plan("q", "awaiting_input")]);
    assert.deepEqual(view.attention.map((a) => [a.reason, a.badge.label]), [["The Architect has questions", "Answer?"]]);
    const project: Project = { id: "blog", dir: "/x", tasks: { total: 0, running: 0, queued: 0, failed: 0, merged: 0 }, plansAwaitingApproval: 0, plansWithQuestions: 1 };
    assert.deepEqual(projectSummary(project), { text: "1 with questions", needsYou: true });
    assert.deepEqual(projectSummary({ ...project, plansWithQuestions: undefined }), { text: "No tasks yet", needsYou: false }, "older Hubs");
  });
});
