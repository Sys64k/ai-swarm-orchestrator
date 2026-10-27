import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isFresh, picked, takesTask, trialStatus, type TrialTask } from "@aso/hub";
import type { JobRecord } from "@aso/shared";

const SINCE = "2026-10-27T12:00:00.000Z";
const trial = { spec: "openai/gpt-6.1-sol", share: 0.1, budgetUsd: 5, since: SINCE };
const build = (startedAt: string, extra: Partial<JobRecord> = {}): JobRecord => ({
  job: "implement", round: 0, host: "avalon", slot: 1, nodeId: "n", startedAt, endedAt: startedAt, result: "built", calls: 1, costUsd: 0.1, ...extra,
});
const task = (extra: Partial<TrialTask>): TrialTask => ({ state: "merged", llm: { costUsd: 0.5 }, ...extra });

describe("challengers", () => {
  it("takes about its share of the work, and always the same work", () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `desks:task-${i}`);
    const taken = keys.filter((k) => picked(k, 0.1)).length;
    assert.ok(taken > 150 && taken < 250, `${taken} of 2000 at 10%`);
    assert.deepEqual(keys.map((k) => picked(k, 0.1)), keys.map((k) => picked(k, 0.1)), "the same answer every time");
    assert.equal(keys.filter((k) => picked(k, 0)).length, 0);
    assert.notDeepEqual(keys.slice(0, 50).map((k) => picked(k, 0.5)), keys.slice(0, 50).map((k) => picked(`reviewer:${k.slice(6)}`, 0.5)), "the two roles take different work");
  });

  it("counts a desks trial's settled tasks and everything they cost, from when it began", () => {
    const tasks = [
      task({ challenger: trial.spec, jobs: [build("2026-10-27T13:00:00.000Z")] }),
      task({ challenger: trial.spec, state: "failed", jobs: [build("2026-10-27T14:00:00.000Z")] }),
      task({ challenger: trial.spec, state: "in_progress", jobs: [] }), // costs already, not settled yet
      task({ challenger: trial.spec, jobs: [build("2026-10-26T09:00:00.000Z")] }), // an earlier trial's
      task({ jobs: [build("2026-10-27T13:00:00.000Z")] }), // not on trial
    ];
    assert.deepEqual(trialStatus("desks", trial, "gpt-6.1-sol", tasks), { model: trial.spec, share: 0.1, budgetUsd: 5, since: SINCE, samples: 2, needed: 10, spentUsd: 1.5 });
  });

  it("counts a reviewer trial's met verdicts by the model's name", () => {
    const tasks = [
      task({ jobs: [build("2026-10-27T13:00:00.000Z", { acceptance: "met", acceptanceModel: "gpt-6.1-sol", acceptanceCostUsd: 0.02 })] }),
      task({ jobs: [build("2026-10-27T13:00:00.000Z", { acceptance: "unmet", acceptanceModel: "gpt-6.1-sol", acceptanceCostUsd: 0.03 })] }),
      task({ jobs: [build("2026-10-27T13:00:00.000Z", { acceptance: "met", acceptanceModel: "claude-opus-5-5", acceptanceCostUsd: 0.5 })] }),
      task({ jobs: [build("2026-10-26T13:00:00.000Z", { acceptance: "met", acceptanceModel: "gpt-6.1-sol" })] }),
    ];
    const s = trialStatus("reviewer", trial, "gpt-6.1-sol", tasks);
    assert.deepEqual([s.samples, s.needed, s.spentUsd, s.ended], [1, 10, 0.05, undefined]);
  });

  it("ends once it has the data suggestions need, or spent its budget", () => {
    const settled = Array.from({ length: 10 }, () => task({ challenger: trial.spec, llm: { costUsd: 0.1 }, jobs: [build("2026-10-27T13:00:00.000Z")] }));
    assert.equal(trialStatus("desks", trial, "x", settled).ended, "enough data");
    const costly = [task({ challenger: trial.spec, state: "in_progress", llm: { costUsd: 5 }, jobs: [] })];
    assert.equal(trialStatus("desks", trial, "x", costly).ended, "budget spent");
  });

  it("takes a task only while the trial runs, by role, and only a task not built yet", () => {
    const all = { ...trial, share: 0.5 };
    const id = Array.from({ length: 40 }, (_, i) => `t${i}`).find((t) => picked(`desks:${t}`, 0.5))!;
    assert.equal(takesTask("desks", all, {}, id), true);
    assert.equal(takesTask("desks", all, { ended: "budget spent" }, id), false, "an ended trial takes nothing");
    assert.equal(isFresh({ reworkRound: 0, jobs: [] }), true);
    assert.equal(isFresh({ reworkRound: 0, jobs: [{ ...build(SINCE), endedAt: undefined }] }), true, "its first build is still running");
    assert.equal(isFresh({ reworkRound: 0, jobs: [build(SINCE)] }), false, "built once already");
    assert.equal(isFresh({ reworkRound: 1 }), false, "a rework");
    assert.equal(isFresh({ reworkRound: 0, challenger: "x/y" }), false, "already on a trial");
  });
});
