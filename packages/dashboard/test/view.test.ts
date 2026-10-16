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
  workerViews,
  buildOf,
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
      },
    ];
    assert.deepEqual(workerViews(nodes), [{ nodeId: "avalon-1", name: "avalon", busy: true, taskId: "api", detail: "12 cores, 32 GiB · CPU 37%", outdated: false }]);
  });

  it("shows each worker's build and whether it needs updating", () => {
    const node = (version: string | undefined, outdated?: boolean): HubNode => ({ nodeId: "w", nodeKind: "worker", heartbeat: null, currentTaskId: null, lastSeenAt: "", version, outdated });
    assert.deepEqual(
      workerViews([node("0.1.0+e422cd7", false), node("0.1.0", true), node(undefined)]).map((w) => [w.detail, w.outdated]),
      [["build e422cd7", false], ["build 0.1.0", true], ["", false]],
    );
    assert.equal(buildOf("0.1.0+abc-dirty"), "abc-dirty");
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
