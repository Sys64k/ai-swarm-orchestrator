import assert from "node:assert/strict";
import { hubPath } from "../lib/hub-routes.ts";
import { describe, it } from "node:test";
import {
  formatUsd,
  trackRecordLine,
  trackRecordsPath,
  homeView,
  isLive,
  isQuiet,
  planProgress,
  previewBody,
  projectNameProblem,
  projectSummary,
  deployView,
  EMPTY_INVITE,
  inviteBody,
  inviteCommand,
  joinCommand,
  workerAccess,
  workerKeyBadge,
  workerKeyRecord,
  workerKeyScope,
  formatDuration,
  hubUpdateView,
  shortCommit,
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
  crewLine,
  agentRows,
  linkParts,
  reviewLink,
  reviewView,
  approveAction,
  canReview,
  checksSummary,
  diffSummary,
  hasChanges,
  patchLines,
  currentTab,
  fileStatusLabel,
  formatBytes,
  screenshotList,
} from "../lib/view.ts";
import type { HubNode, Plan, PlannedTask, Project, ReviewChecks, Task, TranscriptEntry } from "../lib/types.ts";

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
      [["r", "Pull request #7 is ready for your review", "Review?", "/tasks/r"]],
    );
    assert.deepEqual(v.running.map((t) => t.spec.taskId), ["w"], "not listed as running too");
    assert.deepEqual(taskBadge(task("r", "awaiting_review")), { label: "Review", tone: "waiting" });
    assert.deepEqual(taskBadge({ state: "failed", supersededBy: "sync-hub-api-new" }), { label: "Superseded", tone: "muted" }, "not a failure to act on");
    assert.deepEqual(taskActions(task("r", "awaiting_review")), { retry: false, cancel: true });
    assert.deepEqual(taskActions({ state: "failed", supersededBy: "sync-hub-api-new" }), { retry: false, cancel: false }, "a superseded task has nothing to retry");
  });

  it("words each stage of the pull request", () => {
    const view = (state: Task["state"], review?: Task["review"]) => reviewView(task("t", state, { review }));
    assert.equal(view("in_progress"), undefined, "no pull requests on this Hub");
    assert.deepEqual(view("awaiting_review", { rounds: 0, error: "HTTP 502" }), { text: "Opening a pull request on GitHub", error: "HTTP 502" });
    assert.deepEqual(view("awaiting_review", { pr, rounds: 2 }), { text: "Pull request #7 is ready for your review (after 2 rounds of changes)", url: pr.url, error: undefined });
    assert.deepEqual(view("in_progress", { pr, rounds: 1 }), { text: "Changes requested on pull request #7; an agent is on it (after 1 round of changes)", url: pr.url });
    assert.deepEqual(view("merged", { pr, rounds: 0 }), { text: "Merged as pull request #7", url: pr.url });
    assert.deepEqual(view("cancelled", { pr, rounds: 0 }), { text: "Pull request #7 was closed", url: pr.url });
    assert.equal(view("in_progress", { rounds: 0 }), undefined, "no pull request yet, nothing to say");
  });

  it("puts the pull request one tap away on the task page", () => {
    assert.deepEqual(reviewLink(task("t", "awaiting_review", { review: { pr, rounds: 0 } })), { label: "Pull request #7 on GitHub", url: pr.url });
    assert.equal(reviewLink(task("t", "awaiting_review", { review: { rounds: 0 } })), undefined, "not opened yet");
    assert.equal(reviewLink(task("t", "in_progress")), undefined);
  });

  it("offers the review only while a pull request waits, and changes while there is a commit of its own", () => {
    assert.equal(canReview(task("t", "awaiting_review", { review: { pr, rounds: 0 } })), true);
    assert.equal(canReview(task("t", "awaiting_review", { review: { rounds: 0 } })), false, "no pull request yet");
    assert.equal(canReview(task("t", "merged", { review: { pr, rounds: 0 } })), false);
    assert.equal(hasChanges(task("t", "testing", { commit: "abc" })), true);
    assert.equal(hasChanges(task("t", "merged", { commit: "abc" })), false, "it is part of main now");
    assert.equal(hasChanges(task("t", "cancelled", { commit: "abc" })), false);
    assert.equal(hasChanges(task("t", "in_progress")), false);
  });

  it("opens a task waiting for review on its changes, and keeps the person's choice while it can", () => {
    const waiting = task("t", "awaiting_review", { review: { pr, rounds: 0 }, commit: "abc" });
    assert.equal(currentTab(undefined, waiting), "changes");
    assert.equal(currentTab("details", waiting), "details");
    assert.equal(currentTab(undefined, task("t", "in_progress")), "live");
    assert.equal(currentTab("changes", task("t", "pending")), "live", "sent back: no commit to show any more");
    const shots = { commit: "0123456789abcdef", at: "2026-10-18T10:00:00.000Z", files: [{ name: "desk_dark-mode.png", mediaType: "image/png", bytes: 35_400 }] };
    assert.equal(currentTab("screenshots", task("t", "awaiting_review", { screenshots: shots })), "screenshots");
    assert.equal(currentTab("screenshots", task("t", "awaiting_review")), "live", "a later QA run took none");
    assert.deepEqual(["added", "deleted", "modified"].map((s) => fileStatusLabel(s as "added")), ["new · ", "deleted · ", ""]);
  });

  it("lists QA screenshots with their console URL and a readable caption", () => {
    const t = task("a b", "awaiting_review", {
      screenshots: { commit: "0123456789abcdef", at: "2026-10-18T10:00:00.000Z", files: [{ name: "desk_dark-mode.png", mediaType: "image/png", bytes: 35_400 }, { name: "page.webp", mediaType: "image/webp", bytes: 1_400_000 }] },
    });
    assert.deepEqual(screenshotList(t), [
      { name: "desk_dark-mode.png", url: "/api/hub/tasks/a%20b/screenshots/desk_dark-mode.png?commit=0123456789ab", caption: "desk dark mode · 35 KB" },
      { name: "page.webp", url: "/api/hub/tasks/a%20b/screenshots/page.webp?commit=0123456789ab", caption: "page · 1.4 MB" },
    ]);
    assert.deepEqual(screenshotList(task("t", "merged")), []);
    assert.deepEqual([820, 35_400, 1_400_000].map(formatBytes), ["820 B", "35 KB", "1.4 MB"]);
  });

  it("words the checks and picks the approve button for them", () => {
    const checks = (overall: ReviewChecks["overall"], list: ReviewChecks["checks"] = [], extra: Partial<ReviewChecks> = {}): ReviewChecks => ({
      pr, headSha: "abc", mergeable: true, overall, checks: list, ...extra,
    });
    const passing = checks("passing", [{ name: "unit", state: "passing" }, { name: "lint", state: "skipped" }]);
    assert.deepEqual(checksSummary(passing), { text: "1 check passed", tone: "good" });
    assert.deepEqual(approveAction(passing), { label: "Approve and merge", confirm: "Merge pull request #7 into main?", force: false, variant: "primary" });
    assert.deepEqual(approveAction(checks("none"))?.force, false, "no CI is no reason to refuse");
    assert.equal(checksSummary(checks("none")).text, "No checks run on this pull request");

    const failing = checks("failing", [{ name: "unit", state: "passing" }, { name: "Playwright e2e", state: "failing" }, { name: "Docker", state: "failing" }]);
    assert.deepEqual(checksSummary(failing), { text: "2 checks failed: Playwright e2e, Docker", tone: "bad" });
    assert.deepEqual(approveAction(failing), {
      label: "Merge anyway", confirm: "2 checks failed: Playwright e2e, Docker. Merge pull request #7 anyway?", force: true, variant: "danger",
    });
    assert.deepEqual(checksSummary(checks("pending", [{ name: "e2e", state: "pending" }])), { text: "1 check still running", tone: "waiting" });
    assert.equal(approveAction(checks("pending"))?.label, "Merge without waiting");
    const unknown = checks("unknown", [], { error: "no access" });
    assert.equal(checksSummary(unknown).text, "Checks can't be read: no access");
    assert.equal(approveAction(unknown)?.force, true);
    const conflict = checks("passing", [], { mergeable: false });
    assert.equal(approveAction(conflict), undefined, "nothing to merge until an agent rebases it");
    assert.equal(checksSummary(conflict).tone, "bad");
  });

  it("sums up a diff and colours a patch without git's file header", () => {
    const file = (additions: number, deletions: number, patch?: string) => ({ path: "a", status: "modified" as const, additions, deletions, binary: false, patch });
    assert.equal(diffSummary({ files: [file(3, 1), file(1, 0)] }), "2 files · +4 −1");
    assert.equal(diffSummary({ files: [file(0, 0)] }), "1 file · +0 −0");
    const patch = ["diff --git a/a b/a", "index 1..2 100644", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", " same", "-old", "+new", "\\ No newline at end of file"].join("\n");
    assert.deepEqual(patchLines(file(1, 1, patch)).map((l) => l.kind), ["hunk", "context", "del", "add", "meta"]);
    assert.deepEqual(patchLines(file(0, 0)), []);
    assert.deepEqual(patchLines(file(0, 0, "diff --git a/m b/m\nold mode 100644\nnew mode 100755")).map((l) => l.text), ["old mode 100644", "new mode 100755"], "a mode change has no hunk");
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

describe("agents", () => {
  const member = (job: "implement" | "test", host: string, slot: number) => ({ job, host, slot, nodeId: `${host}-x`, at: "" });

  it("says which agents built and tested a task, and who is on it now", () => {
    assert.equal(crewLine(task("t", "pending")), undefined);
    assert.equal(crewLine(task("t", "in_progress", { crew: [member("implement", "avalon", 2)] })), "Building: avalon #2");
    const done = [member("implement", "avalon", 2), member("test", "canfod", 1)];
    assert.equal(crewLine(task("t", "testing", { crew: done })), "Built by avalon #2 · testing: canfod #1");
    assert.equal(crewLine(task("t", "merged", { crew: done })), "Built by avalon #2 · tested by canfod #1");
    const reworked = [...done, member("implement", "canfod", 2), member("test", "avalon", 1), member("test", "avalon", 1)];
    assert.equal(crewLine(task("t", "awaiting_review", { crew: reworked })), "Built by avalon #2, then canfod #2 · tested by canfod #1, then avalon #1");
  });

  it("lists every desk of a machine as an agent, with its work now and last", () => {
    const node: HubNode = {
      nodeId: "avalon-1",
      nodeKind: "worker",
      heartbeat: null,
      currentTaskId: "a",
      currentTaskIds: ["a", "b", "c"],
      lastSeenAt: "",
      slots: 4,
      hardware: { hostname: "avalon", cpu: { logicalCores: 12 }, memory: { totalBytes: 1 } },
      jobs: [{ taskId: "a", job: "implement", slot: 3 }, { taskId: "b", job: "test", slot: 1 }, { taskId: "c", job: "implement" }],
    };
    const tasks = [
      task("a", "in_progress"),
      task("b", "testing"),
      task("c", "in_progress"),
      task("old", "merged", { crew: [{ ...member("implement", "avalon", 4), at: "2026-10-16T10:00:00Z" }] }),
      task("older", "merged", { crew: [{ ...member("implement", "avalon", 4), at: "2026-10-16T09:00:00Z" }] }),
      task("elsewhere", "merged", { crew: [member("implement", "canfod", 4)] }),
    ];
    const rows = agentRows(node, tasks);
    assert.deepEqual(rows.map((r) => r.name), ["avalon #1", "avalon #2", "avalon #3", "avalon #4"]);
    assert.deepEqual(rows.map((r) => r.now?.taskId), ["b", "c", "a", undefined], "reported desks first; a job without one takes the first free desk");
    assert.deepEqual([rows[0].now?.job, rows[0].now?.title], ["test", "Task b"]);
    assert.deepEqual([rows[3].last?.taskId, rows[3].last?.badge.label], ["old", "Merged"], "the newest work of that desk on this machine");
    assert.deepEqual(agentRows({ ...node, nodeKind: "architect" }, tasks), []);
    assert.deepEqual(agentRows({ ...node, slots: undefined, currentTaskIds: [], jobs: [] }, []).map((r) => r.name), ["avalon #1"], "one desk on an older Hub");
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
    const failedDeploy = { configured: true, last: { state: "failed" as const, commit: "a".repeat(40), startedAt: "2026-10-24T10:00:00Z" } };
    assert.deepEqual(projectSummary({ ...project, plansWithQuestions: 0, deploy: failedDeploy }), { text: "deploy failed", needsYou: true });
  });
});

describe("deploys and the Hub's own update", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const sha = "a18d17b".padEnd(40, "0");

  it("shortens commits and versions, and says durations", () => {
    assert.equal(shortCommit("0.1.0+a914b89"), "a914b89");
    assert.equal(shortCommit(sha), "a18d17b");
    assert.deepEqual([500, 42_000, 192_000, 180_000, 3_900_000].map(formatDuration), ["less than a second", "42 s", "3 min 12 s", "3 min", "1 h 5 min"]);
    assert.equal(formatDuration(Number.NaN), "less than a second", "a broken time");
  });

  it("shows a project's deploy only when it has a command, and what the last one did", () => {
    assert.equal(deployView(undefined, now), undefined, "an older Hub");
    assert.equal(deployView({ configured: false }, now), undefined);
    assert.deepEqual(deployView({ configured: true }, now), { label: "No deploy since the Hub started", tone: "muted", canDeploy: true });
    assert.deepEqual(deployView({ configured: true, last: { state: "running", commit: sha, startedAt: "2026-10-24T11:59:30Z" } }, now), {
      label: "Deploying a18d17b…",
      tone: "active",
      detail: "started just now",
      canDeploy: false,
    });
    assert.deepEqual(deployView({ configured: true, last: { state: "succeeded", commit: sha, startedAt: "2026-10-24T11:50:00Z", finishedAt: "2026-10-24T11:50:45Z" } }, now), {
      label: "Deployed a18d17b",
      tone: "good",
      detail: "9 min ago, took 45 s",
      canDeploy: true,
    });
    const failed = deployView({ configured: true, last: { state: "failed", commit: sha, startedAt: "2026-10-24T11:00:00Z", finishedAt: "2026-10-24T11:01:00Z", error: "exited with code 1", output: "\nnpm error boom\n" } }, now)!;
    assert.deepEqual(failed, { label: "Deploy of a18d17b failed", tone: "bad", detail: "exited with code 1 · 59 min ago", output: "npm error boom", canDeploy: true });
  });

  it("says what the Hub runs and where its update stands", () => {
    const at = "2026-10-24T11:58:00Z";
    const view = (state: "off" | "current" | "building" | "waiting" | "restarting" | "updated" | "failed", extra = {}) =>
      hubUpdateView({ state, current: "0.1.0+a914b89", target: "5147fe7".padEnd(40, "1"), at, ...extra }, now);
    assert.equal(hubUpdateView(undefined, now), undefined, "an older Hub");
    assert.deepEqual(view("off"), { label: "Hub a914b89", tone: "muted", detail: "doesn't update itself", banner: false });
    assert.deepEqual(view("current"), { label: "Hub a914b89", tone: "good", detail: "up to date", banner: false });
    assert.deepEqual(view("building"), { label: "Testing update 5147fe7…", tone: "active", detail: "Hub runs a914b89", banner: false });
    assert.equal(view("waiting")?.label, "Update 5147fe7 ready");
    assert.deepEqual(view("restarting"), { label: "Restarting onto 5147fe7…", tone: "active", banner: false });
    assert.deepEqual(view("updated"), { label: "Updated to a914b89", tone: "good", detail: "2 min ago", banner: false });
    assert.deepEqual(view("failed", { error: "build or tests failed: npm test exited with code 1" }), {
      label: "Update 5147fe7 failed",
      tone: "bad",
      detail: "build or tests failed: npm test exited with code 1 · Hub still runs a914b89",
      banner: true,
    });
    assert.equal(view("failed", { target: undefined, error: "could not read the repository's main" })?.label, "Update failed");
  });
});

describe("worker machines and their keys", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  it("gives the new machine its commands, with the Hub's name as the console knows it", () => {
    // The same line as the CLI's joinCommand (packages/cli/test/join.test.ts asserts this string too).
    assert.equal(joinCommand("agent007", "CODE123", "ab12"), 'd=$(mktemp -d) && curl -fo "$d/aso.tgz" http://agent007:7420/dist/aso.tgz && echo "ab12  $d/aso.tgz" | sha256sum -c - && npm install -g "$d/aso.tgz" && aso service install --join CODE123');
    assert.equal(
      joinCommand("agent007.tailc9777f.ts.net", "C0DE"),
      'd=$(mktemp -d) && curl -fo "$d/aso.tgz" http://agent007.tailc9777f.ts.net:7420/dist/aso.tgz && npm install -g "$d/aso.tgz" && aso service install --join C0DE',
      "one line, and no --hub: the worker finds the Hub on the LAN or over Tailscale",
    );
    assert.match(joinCommand("::1", "C"), /http:\/\/\[::1\]:7420\//);
  });
  it("says what became of each machine's jobs, as the CLI does", () => {
    assert.equal(workerKeyRecord({ built: 2, qaPassed: 2, qaFailed: 1, accepted: 1, tested: 1 }), "2 builds · QA passed 2 of 3 · acceptance met 1 of 1 · 1 QA run");
    assert.equal(workerKeyRecord({ built: 1, failed: 1, dropped: 2 }), "1 build · 1 failed · 2 dropped");
    assert.equal(workerKeyRecord(undefined), "No jobs yet", "an older Hub, or a new key");
  });

  it("gives a machine on the internet the same line as the CLI, and builds the invite", () => {
    // The same string as the CLI's joinCommand for a wss:// address (packages/cli/test/join.test.ts).
    assert.equal(
      joinCommand("wss://agent007.tailc9777f.ts.net:10000", "C0DE"),
      'd=$(mktemp -d) && curl -fo "$d/aso.tgz" https://agent007.tailc9777f.ts.net:10000/dist/aso.tgz && npm install -g "$d/aso.tgz" && aso service install --hub wss://agent007.tailc9777f.ts.net:10000 --join C0DE',
    );
    assert.match(joinCommand("wss://h:10000/", "C", "ab12"), /https:\/\/h:10000\/dist\/aso\.tgz && echo "ab12  \$d\/aso\.tgz" \| sha256sum -c -/);
    const plain = EMPTY_INVITE;
    assert.deepEqual(inviteBody(plain), { body: {} }, "a trusted machine for every project");
    assert.deepEqual(inviteBody({ ...EMPTY_INVITE, name: " friend ", untrusted: true, projects: ["aso-ui"], budget: "10,5" }), {
      body: { name: "friend", trusted: false, projects: ["aso-ui"], budgetUsd: 10.5 },
    });
    assert.ok("error" in inviteBody({ ...plain, budget: "ten" }));
    assert.ok("error" in inviteBody({ ...plain, budget: "-1" }));
    const at = { hostname: "agent007", code: "C", sha256: null };
    assert.deepEqual(inviteCommand({ ...at, internet: false, gatewayUrl: "wss://g:10000" }), { command: joinCommand("agent007", "C") }, "this network: the console's host");
    assert.deepEqual(inviteCommand({ ...at, internet: true, gatewayUrl: "wss://g:10000" }), { command: joinCommand("wss://g:10000", "C") });
    assert.match((inviteCommand({ ...at, internet: true }) as { error: string }).error, /no public gateway address/);
  });

  it("says what each key may do", () => {
    assert.equal(workerKeyScope({}), "Trusted · all projects", "a key from an older Hub");
    assert.equal(workerKeyScope({ trusted: false, projects: ["aso-ui"], budgetUsd: 10, spentUsd: 1.2 }), "Untrusted: builds only · aso-ui · $1.20 of $10");
    assert.equal(workerKeyScope({ trusted: true, spentUsd: 3 }), "Trusted · all projects · $3.00 spent");
    assert.equal(hubPath("POST", ["worker-keys", "fecac655"]), "/api/worker-keys/fecac655", "the console can trust or untrust a machine");
    assert.equal(hubPath("POST", ["worker-keys", "join"]), undefined, "but not join");
    assert.equal(hubPath("POST", ["worker-keys", "join-codes"]), "/api/worker-keys/join-codes", "(its own route)");
  });

  it("says where each key stands and how a worker connected", () => {
    assert.deepEqual(workerKeyBadge({ connected: true }, now), { label: "Connected", tone: "good" });
    assert.deepEqual(workerKeyBadge({ connected: false }, now), { label: "Not connected", tone: "waiting", detail: "never joined" });
    assert.deepEqual(workerKeyBadge({ connected: false, lastUsedAt: "2026-10-24T11:50:00Z" }, now).detail, "last seen 10 min ago");
    assert.deepEqual(workerKeyBadge({ connected: true, revokedAt: "2026-10-24T11:00:00Z" }, now), { label: "Revoked", tone: "muted", detail: "1 h ago" });
    assert.equal(workerAccess({ workerKey: { id: "k", name: "avalon" } }), 'key "avalon"');
    assert.equal(workerAccess({ workerKey: null }), "the Hub's main token");
    assert.equal(workerAccess({}), undefined, "an older Hub");
  });
});

describe("track records page", () => {
  const row = {
    key: "models/gemini-3.8-flash",
    builds: { jobs: 5, built: 4, unverified: 0, failed: 1, outOfTurns: 2, modelRefused: 0, dropped: 0, cancelled: 0, qaPassed: 3, qaFailed: 1, accepted: 2, unmet: 0 },
    qaRuns: { runs: 0, passed: 0, failed: 0, errors: 0, dropped: 0 },
    tasks: { worked: 3, finished: 2, firstTry: 1, tookOver: 1 },
    costUsd: 0.5,
    costPerFinishedUsd: 0.25,
  };

  it("says a record in a line", () => {
    assert.equal(
      trackRecordLine(row),
      "2 tasks finished (1 first try, 1 taken over) · 5 builds · QA passed 3 of 4 · acceptance met 2 of 2 · 2 out of turns · 1 failed · $0.50, $0.25 a task",
    );
    const tester = { ...row, key: "canfod", builds: { ...row.builds, jobs: 0, built: 0, failed: 0, outOfTurns: 0, qaPassed: 0, qaFailed: 0, accepted: 0 }, qaRuns: { runs: 4, passed: 3, failed: 1, errors: 0, dropped: 0 }, tasks: { worked: 0, finished: 0, firstTry: 0, tookOver: 0 }, costUsd: 0, costPerFinishedUsd: undefined };
    assert.equal(trackRecordLine(tester), "4 QA runs (3 of 4 passed)");
    assert.equal(trackRecordLine({ ...tester, qaRuns: { runs: 1, passed: 0, failed: 0, errors: 1, dropped: 0 } }), "1 QA run", "no verdict, no rate");
    assert.match(trackRecordLine({ ...row, tasks: { ...row.tasks, finished: 0, firstTry: 0, tookOver: 0 }, costPerFinishedUsd: undefined }), /^no task finished yet · 5 builds .* · \$0\.50$/);
  });

  it("asks the Hub for the grouping and project chosen, through an allowed route", () => {
    assert.equal(trackRecordsPath("model"), "track-records?by=model");
    assert.equal(trackRecordsPath("host", "aso-ui"), "track-records?by=host&project=aso-ui");
    assert.equal(hubPath("GET", ["track-records"]), "/api/track-records");
    assert.equal(hubPath("POST", ["track-records"]), undefined);
  });
});
