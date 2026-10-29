import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackRecords, type ReportPlan, type ReportTask } from "@aso/hub";
import { COUNTED_BUILD_RESULTS, TrackRecordRowSchema, type JobRecord } from "@aso/shared";

let clock = Date.parse("2026-10-27T10:00:00.000Z");
const at = () => new Date((clock += 60_000)).toISOString();

function build(model: string, result: JobRecord["result"], extra: Partial<JobRecord> = {}): JobRecord {
  return { job: "implement", round: 0, host: "avalon", slot: 1, nodeId: "n", model, startedAt: at(), endedAt: at(), result, calls: 3, costUsd: 0.1, ...extra };
}
const qaRun = (host: string, result: JobRecord["result"]): JobRecord => ({ job: "test", round: 0, host, slot: 1, nodeId: "q", startedAt: at(), endedAt: at(), result, calls: 0, costUsd: 0 });
const task = (jobs: JobRecord[], extra: Partial<ReportTask> = {}): ReportTask => ({ project: "shop", state: "merged", spec: { role: "frontend" }, jobs, ...extra });

describe("track records", () => {
  const tasks = [
    // Gemini, first try.
    task([build("gemini", "built", { qa: "passed", acceptance: "met" }), qaRun("canfod", "passed")]),
    // Gemini runs out of turns twice; Opus takes over and finishes.
    task([
      build("gemini", "outOfTurns"),
      build("gemini", "outOfTurns", { round: 1 }),
      build("opus", "built", { round: 2, qa: "passed", acceptance: "met", costUsd: 0.9 }),
      qaRun("avalon", "passed"),
    ]),
    // Gemini: QA fails once, then passes. Backend, another project.
    task([build("gemini", "built", { qa: "failed" }), qaRun("canfod", "qaFailed"), build("gemini", "built", { round: 1, qa: "passed" }), qaRun("canfod", "passed")], { project: "blog", spec: { role: "backend" } }),
    // Haiku fails a task for good.
    task([build("haiku", "failed")], { state: "failed" }),
    // Still being checked, and still running: neither counts yet.
    task([build("haiku", "pushed"), { ...build("haiku", undefined), endedAt: undefined }], { state: "verifying" }),
    // From before track records: no jobs.
    task([], { state: "merged" }),
  ];

  it("counts each model's builds, what came of them, and the tasks it finished", () => {
    const r = trackRecords(tasks, [], { by: "model" });
    assert.deepEqual(r.rows.map((x) => x.key), ["gemini", "opus", "haiku"], "most tasks finished first");
    const gemini = r.rows[0];
    assert.deepEqual(gemini.builds, { jobs: 5, built: 3, unverified: 0, failed: 0, outOfTurns: 2, modelRefused: 0, dropped: 0, cancelled: 0, qaPassed: 2, qaFailed: 1, accepted: 1, unmet: 0 });
    assert.deepEqual(gemini.tasks, { worked: 3, finished: 2, firstTry: 1, tookOver: 0 });
    assert.equal(gemini.costUsd, 0.5);
    assert.equal(gemini.costPerFinishedUsd, 0.25);
    assert.deepEqual(gemini.qaRuns.runs, 0, "QA runs have no model");
    const opus = r.rows[1];
    assert.deepEqual(opus.tasks, { worked: 1, finished: 1, firstTry: 0, tookOver: 1 }, "it took over from Gemini");
    const haiku = r.rows[2];
    assert.deepEqual([haiku.builds.jobs, haiku.builds.failed, haiku.tasks.finished, haiku.costPerFinishedUsd], [1, 1, 0, undefined]);
    assert.equal(r.since, tasks[0].jobs![0].startedAt, "from the oldest job counted");
  });

  it("counts machines' QA runs, and groups by desk, role and project", () => {
    const hosts = trackRecords(tasks, [], { by: "host" });
    const canfod = hosts.rows.find((x) => x.key === "canfod")!;
    assert.deepEqual(canfod.qaRuns, { runs: 3, passed: 2, failed: 1, errors: 0, dropped: 0 });
    assert.equal(canfod.builds.jobs, 0);
    const avalon = hosts.rows.find((x) => x.key === "avalon")!;
    assert.deepEqual([avalon.builds.jobs, avalon.qaRuns.runs, avalon.tasks.finished, avalon.tasks.tookOver], [7, 1, 3, 0], "one machine built them all");
    assert.deepEqual(trackRecords(tasks, [], { by: "desk" }).rows.map((x) => x.key).sort(), ["avalon #1", "canfod #1"]);
    assert.deepEqual(trackRecords(tasks, [], { by: "role" }).rows.map((x) => [x.key, x.tasks.finished]), [["frontend", 2], ["backend", 1]]);
    assert.deepEqual(trackRecords(tasks, [], { by: "project" }).rows.map((x) => x.key), ["shop", "blog"]);
  });

  it("filters by project, role and time", () => {
    assert.deepEqual(trackRecords(tasks, [], { by: "model", project: "blog" }).rows.map((x) => [x.key, x.builds.jobs]), [["gemini", 2]]);
    assert.deepEqual(trackRecords(tasks, [], { by: "model", role: "backend" }).rows.map((x) => x.key), ["gemini"]);
    const late = tasks[1].jobs![2].startedAt; // Opus's build
    const since = trackRecords(tasks, [], { by: "model", since: late });
    assert.ok(!since.rows.some((x) => x.key === "opus" && x.builds.jobs === 0));
    assert.ok(since.rows.every((x) => x.key !== "gemini" || x.tasks.worked === 1), "Gemini's earlier jobs aren't counted");
    assert.deepEqual(trackRecords([], [], { by: "model" }), { by: "model", since: null, rows: [] });
  });

  it("groups and filters by the task's level, leaving plans out of a level filter", () => {
    const levelled = [
      task([build("qwen", "built", { qa: "passed" })], { spec: { role: "frontend", level: 1 } }),
      task([build("qwen", "failed")], { state: "failed", spec: { role: "frontend", level: 3 } }),
      task([build("gemini", "built")], { spec: { role: "backend", level: 3 } }),
      task([build("gemini", "built")]),
    ];
    const plan: ReportPlan = { project: "shop", state: "approved", model: "opus", llm: { costUsd: 1 }, createdAt: at() };
    const byLevel = trackRecords(levelled, [plan], { by: "level", model: "qwen" }).rows;
    assert.deepEqual(byLevel.map((x) => [x.key, x.tasks.finished, x.builds.failed]), [["level 1", 1, 0], ["level 3", 0, 1]], "one model's ladder");
    assert.deepEqual(trackRecords(levelled, [plan], { by: "level" }).rows.map((x) => x.key).sort(), ["level 1", "level 3", "no level"], "no plans: they have no level");
    const three = trackRecords(levelled, [plan], { by: "model", level: 3 }).rows;
    assert.deepEqual(three.map((x) => [x.key, x.builds.jobs]), [["gemini", 1], ["qwen", 1]]);
    assert.ok(!three.some((x) => x.key === "opus"), "the plan isn't counted");
  });

  it("counts only a period's jobs between since and until, for trends", () => {
    const opusAt = tasks[1].jobs![2].startedAt; // Opus's build, after Gemini's first two there
    const before = trackRecords(tasks, [], { by: "model", until: opusAt });
    assert.ok(!before.rows.some((x) => x.key === "opus"), "until is exclusive: Opus started then");
    assert.equal(before.rows.find((x) => x.key === "gemini")!.builds.jobs, 3, "Gemini's builds in the first two tasks");
    const week = trackRecords(tasks, [], { by: "model", since: opusAt, until: new Date(Date.parse(opusAt) + 1).toISOString() });
    assert.deepEqual(week.rows.map((x) => [x.key, x.builds.jobs, x.tasks.finished]), [["opus", 1, 1]]);
  });
});

describe("track records, in step and over time", () => {
  it("counts every build result the job records know (the schema and the results agree)", () => {
    const fields = Object.keys(TrackRecordRowSchema.shape.builds.shape);
    assert.deepEqual(fields, ["jobs", ...COUNTED_BUILD_RESULTS, "qaPassed", "qaFailed", "accepted", "unmet"]);
  });

  it("doesn't call a reworked task a first try because its earlier builds fall before --since", () => {
    const reworked = task([build("gemini", "built", { qa: "failed" }), build("gemini", "built", { round: 1, qa: "passed" })]);
    const since = reworked.jobs![1].startedAt;
    const gemini = trackRecords([reworked], [], { by: "model", since }).rows[0];
    assert.deepEqual([gemini.builds.jobs, gemini.tasks.finished, gemini.tasks.firstTry], [1, 1, 0]);
    assert.deepEqual(trackRecords([reworked], [], { by: "model", since: at() }).rows, [], "finished before --since: not counted");
  });
});

describe("track records of plans and acceptance checks", () => {
  const plan = (model: string | undefined, state: ReportPlan["state"], kinds: string[] = [], extra: Partial<ReportPlan> = {}): ReportPlan => ({
    project: "shop",
    state,
    ...(model ? { model } : {}),
    dialogue: kinds.map((kind) => ({ kind })),
    llm: { costUsd: 0.4 },
    createdAt: at(),
    ...extra,
  });
  const plans = [
    plan("opus", "approved", ["questions", "reply", "proposal"]),
    plan("opus", "rejected", ["proposal"]),
    plan("opus", "awaiting_input", ["questions"]),
    plan("gemini", "failed"),
    plan(undefined, "pending"), // not planned yet: counts for nobody
    plan("opus", "approved", ["proposal"], { project: "blog" }),
  ];
  const reviewed = [
    task([
      build("gemini", "built", { acceptance: "unmet", acceptanceModel: "opus", acceptanceCostUsd: 0.05 }),
      build("gemini", "built", { round: 1, acceptance: "met", acceptanceModel: "opus", acceptanceCostUsd: 0.06 }),
    ]),
    task([build("haiku", "built", { acceptance: "undecided", acceptanceModel: "haiku", acceptanceCostUsd: 0.01 })], { project: "blog" }),
  ];

  it("counts each Architect model's plans and each reviewer model's acceptance checks", () => {
    const rows = trackRecords(reviewed, plans, { by: "model" }).rows;
    const opus = rows.find((r) => r.key === "opus")!;
    assert.deepEqual(opus.plans, { planned: 4, proposed: 3, approved: 2, rejected: 1, failed: 0, withQuestions: 2, costUsd: 1.6 });
    assert.deepEqual(opus.reviews, { checks: 2, met: 1, overturned: 0, unmet: 1, undecided: 0, costUsd: 0.11 });
    assert.equal(opus.builds.jobs, 0, "Opus only planned and reviewed here");
    assert.deepEqual(rows.find((r) => r.key === "gemini")!.plans, { planned: 1, proposed: 0, approved: 0, rejected: 0, failed: 1, withQuestions: 0, costUsd: 0.4 });
    assert.deepEqual(rows.find((r) => r.key === "haiku")!.reviews.undecided, 1, "a model can review its own kind's work");
  });

  it("shows one model's work only: its builds, tasks, plans and checks, grouped any way", () => {
    const work = [
      ...reviewed,
      // Gemini starts, Opus takes over and finishes: Opus finished it, Gemini started it.
      task([build("gemini", "outOfTurns"), build("opus", "built", { round: 1, acceptance: "met", acceptanceModel: "sol" }), qaRun("canfod", "passed")], { project: "blog" }),
    ];
    const opus = trackRecords(work, plans, { by: "model", model: "opus" });
    assert.deepEqual(opus.rows.map((r) => r.key), ["opus"]);
    assert.deepEqual(
      [opus.rows[0].builds.jobs, opus.rows[0].tasks.finished, opus.rows[0].started.settled, opus.rows[0].plans.planned, opus.rows[0].reviews.checks],
      [1, 1, 0, 4, 2],
      "it started none: Gemini did",
    );
    const byProject = trackRecords(work, plans, { by: "project", model: "gemini" }).rows;
    assert.deepEqual(
      byProject.map((r) => [r.key, r.builds.jobs, r.started.settled, r.tasks.finished, r.reviews.checks, r.plans.planned, r.qaRuns.runs]),
      [["shop", 2, 1, 1, 0, 1, 0], ["blog", 1, 1, 0, 0, 0, 0]],
      "Gemini's builds and plans per project; its tasks Opus checked and finished don't count; no QA runs",
    );
    assert.deepEqual(trackRecords(work, plans, { by: "host", model: "nobody" }), { by: "host", since: null, rows: [] });
  });

  it("counts a reviewer's met verdicts that proved wrong later", () => {
    const overturned = [
      task([build("gemini", "built", { acceptance: "met", acceptanceModel: "sol", overturned: "changesRequested" })]),
      task([build("gemini", "built", { acceptance: "met", acceptanceModel: "sol" })]),
      task([build("gemini", "built", { acceptance: "met", acceptanceModel: "sol", overturned: "deployFailed" })], { project: "blog" }),
    ];
    assert.deepEqual(trackRecords(overturned, [], { by: "model" }).rows.find((r) => r.key === "sol")!.reviews, { checks: 3, met: 3, overturned: 2, unmet: 0, undecided: 0, costUsd: 0 });
    assert.equal(trackRecords(overturned, [], { by: "project" }).rows.find((r) => r.key === "blog")!.reviews.overturned, 1);
  });

  it("counts them per project too, and never per machine, desk or role", () => {
    const shop = trackRecords(reviewed, plans, { by: "project" }).rows.find((r) => r.key === "shop")!;
    assert.deepEqual([shop.plans.planned, shop.reviews.checks], [4, 2]);
    for (const by of ["host", "desk", "role"] as const) {
      assert.ok(trackRecords(reviewed, plans, { by }).rows.every((r) => r.plans.planned === 0 && r.reviews.checks === 0), by);
    }
    assert.equal(trackRecords(reviewed, plans, { by: "model", role: "frontend" }).rows.find((r) => r.key === "opus")!.plans.planned, 0, "plans have no role");
    assert.equal(trackRecords(reviewed, plans, { by: "model", project: "blog" }).rows.find((r) => r.key === "opus")!.plans.planned, 1);
  });
});

describe("what a task costs, all in, by where it started", () => {
  const tasks = [
    // Gemini, first try; from plan p1.
    task([build("gemini", "built", { acceptance: "met", acceptanceCostUsd: 0.02 })], { planId: "p1" }),
    // Gemini runs out of turns twice; Opus finishes. Also from p1, in another project.
    task(
      [
        build("gemini", "outOfTurns"),
        build("gemini", "outOfTurns", { round: 1 }),
        build("opus", "built", { round: 2, acceptance: "met", acceptanceCostUsd: 0.05, costUsd: 0.9 }),
      ],
      { planId: "p1", project: "blog", spec: { role: "backend" } },
    ),
    // Haiku fails it for good: its cost counts, with no task to show for it.
    task([build("haiku", "failed")], { state: "failed" }),
    // Cancelled by a person, and still being checked: neither counts.
    task([build("gemini", "built")], { state: "cancelled" }),
    task([build("gemini", "pushed")], { state: "verifying" }),
  ];
  const plans: ReportPlan[] = [
    { planId: "p1", project: "shop", state: "approved", model: "opus", llm: { costUsd: 0.3 }, createdAt: at() },
    // Rejected: led to no task, so no task carries its cost.
    { planId: "p2", project: "shop", state: "rejected", model: "opus", llm: { costUsd: 0.2 }, createdAt: at() },
  ];

  it("charges every build on any model, the acceptance checks and a share of the plan to the model a task started on", () => {
    const rows = trackRecords(tasks, plans, { by: "model" }).rows;
    const gemini = rows.find((r) => r.key === "gemini")!;
    // (0.1 + 0.02 + 0.15) + (0.1 + 0.1 + 0.9 + 0.05 + 0.15)
    assert.deepEqual(gemini.started, { settled: 2, finished: 2, costUsd: 1.57, costPerFinishedUsd: 0.785 });
    assert.equal(gemini.costPerFinishedUsd, 0.4, "its own builds (the cancelled task's too) per task it finished itself: Opus's takeover is left out there");
    assert.deepEqual(rows.find((r) => r.key === "opus")!.started, { settled: 0, finished: 0, costUsd: 0 }, "it only took over");
    assert.deepEqual(rows.find((r) => r.key === "haiku")!.started, { settled: 1, finished: 0, costUsd: 0.1 }, "a failed task costs, and finishes nothing");
  });

  it("groups by the task's own role and project, and by the machine and desk of its first build", () => {
    assert.deepEqual(
      trackRecords(tasks, plans, { by: "project" }).rows.map((r) => [r.key, r.started.settled, r.started.costUsd]),
      [["shop", 2, 0.37], ["blog", 1, 1.3]],
    );
    assert.deepEqual(trackRecords(tasks, plans, { by: "host" }).rows[0].started, { settled: 3, finished: 2, costUsd: 1.67, costPerFinishedUsd: 0.835 });
    assert.equal(trackRecords(tasks, plans, { by: "model", role: "frontend" }).rows.find((r) => r.key === "gemini")!.started.costUsd, 0.27, "the plan's share stays a share when other tasks are filtered out");
  });

  it("counts a task from when its first build started", () => {
    const late = trackRecords(tasks, plans, { by: "model", since: tasks[1].jobs![2].startedAt });
    assert.equal(late.rows.find((r) => r.key === "gemini")!.started.settled, 0, "Opus's build is after --since, but both of Gemini's tasks started before");
    assert.equal(late.rows.find((r) => r.key === "haiku")!.started.settled, 1, "Haiku's started after");
    const parsed = TrackRecordRowSchema.safeParse(trackRecords(tasks, plans, { by: "model" }).rows[0]);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });
});
