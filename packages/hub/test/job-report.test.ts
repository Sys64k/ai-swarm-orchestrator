import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackRecords, type ReportTask } from "@aso/hub";
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
    const r = trackRecords(tasks, { by: "model" });
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
    const hosts = trackRecords(tasks, { by: "host" });
    const canfod = hosts.rows.find((x) => x.key === "canfod")!;
    assert.deepEqual(canfod.qaRuns, { runs: 3, passed: 2, failed: 1, errors: 0, dropped: 0 });
    assert.equal(canfod.builds.jobs, 0);
    const avalon = hosts.rows.find((x) => x.key === "avalon")!;
    assert.deepEqual([avalon.builds.jobs, avalon.qaRuns.runs, avalon.tasks.finished, avalon.tasks.tookOver], [7, 1, 3, 0], "one machine built them all");
    assert.deepEqual(trackRecords(tasks, { by: "desk" }).rows.map((x) => x.key).sort(), ["avalon #1", "canfod #1"]);
    assert.deepEqual(trackRecords(tasks, { by: "role" }).rows.map((x) => [x.key, x.tasks.finished]), [["frontend", 2], ["backend", 1]]);
    assert.deepEqual(trackRecords(tasks, { by: "project" }).rows.map((x) => x.key), ["shop", "blog"]);
  });

  it("filters by project, role and time", () => {
    assert.deepEqual(trackRecords(tasks, { by: "model", project: "blog" }).rows.map((x) => [x.key, x.builds.jobs]), [["gemini", 2]]);
    assert.deepEqual(trackRecords(tasks, { by: "model", role: "backend" }).rows.map((x) => x.key), ["gemini"]);
    const late = tasks[1].jobs![2].startedAt; // Opus's build
    const since = trackRecords(tasks, { by: "model", since: late });
    assert.ok(!since.rows.some((x) => x.key === "opus" && x.builds.jobs === 0));
    assert.ok(since.rows.every((x) => x.key !== "gemini" || x.tasks.worked === 1), "Gemini's earlier jobs aren't counted");
    assert.deepEqual(trackRecords([], { by: "model" }), { by: "model", since: null, rows: [] });
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
    const gemini = trackRecords([reworked], { by: "model", since }).rows[0];
    assert.deepEqual([gemini.builds.jobs, gemini.tasks.finished, gemini.tasks.firstTry], [1, 1, 0]);
    assert.deepEqual(trackRecords([reworked], { by: "model", since: at() }).rows, [], "finished before --since: not counted");
  });
});
