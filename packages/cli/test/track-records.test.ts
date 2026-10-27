import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackRecordLines, trackRecordsPath } from "../dist/commands/track-records.js";

const row = (key: string, extra: { finished?: number; qaPassed?: number; qaFailed?: number; runs?: number; passed?: number; cost?: number } = {}) => ({
  key,
  builds: { jobs: 5, built: 4, unverified: 0, failed: 1, outOfTurns: 2, modelRefused: 0, dropped: 0, cancelled: 0, qaPassed: extra.qaPassed ?? 3, qaFailed: extra.qaFailed ?? 1, accepted: 2, unmet: 0 },
  qaRuns: { runs: extra.runs ?? 0, passed: extra.passed ?? 0, failed: 0, errors: 0, dropped: 0 },
  tasks: { worked: 3, finished: extra.finished ?? 2, firstTry: 1, tookOver: 0 },
  costUsd: extra.cost ?? 0.5,
  ...(extra.finished === 0 ? {} : { costPerFinishedUsd: (extra.cost ?? 0.5) / (extra.finished ?? 2) }),
  plans: { planned: 0, proposed: 0, approved: 0, rejected: 0, failed: 0, withQuestions: 0, costUsd: 0 },
  reviews: { checks: 0, met: 0, unmet: 0, undecided: 0, costUsd: 0 },
});

describe("aso track-records", () => {
  it("asks for what was given", () => {
    assert.equal(trackRecordsPath({ by: "model" }), "/api/track-records?by=model");
    assert.equal(trackRecordsPath({ by: "host", project: "aso-ui", since: "2026-10-01" }), "/api/track-records?by=host&project=aso-ui&since=2026-10-01");
  });

  it("prints one aligned row each, with rates as good out of all", () => {
    const lines = trackRecordLines({ by: "model", since: "2026-10-27T12:00:00.000Z", rows: [row("models/gemini-3.8-flash"), row("claude-opus-5-5", { finished: 0, qaPassed: 0, qaFailed: 0 })] });
    assert.equal(lines[0], "Track records by model, from jobs since 2026-10-27T12:00:00.000Z:");
    const [header, gemini, opus] = lines.slice(2, 5);
    assert.match(header, /^MODEL\s+FINISHED\s+1ST TRY\s+TOOK OVER\s+BUILDS\s+QA PASSED\s+ACCEPTED\s+OUT OF TURNS\s+FAILED\s+COST\s+PER TASK$/);
    assert.ok(!header.includes("QA RUNS"), "models don't run QA");
    assert.match(gemini, /^models\/gemini-3\.8-flash\s+2\s+1\s+0\s+5\s+3\/4\s+2\/2\s+2\s+1\s+\$0\.50\s+\$0\.25$/);
    assert.match(opus, /^claude-opus-5-5\s+0 .*\s-\s.*\$0\.50\s+-$/, "no QA verdicts and no task finished: dashes");
    assert.equal(header.indexOf("FINISHED"), gemini.indexOf("2"), "columns line up");
  });

  it("shows machines' QA runs, and says when there is nothing yet", () => {
    const lines = trackRecordLines({ by: "host", since: null, rows: [{ ...row("canfod", { runs: 5, passed: 3 }), qaRuns: { runs: 5, passed: 3, failed: 1, errors: 1, dropped: 0 } }] });
    assert.match(lines[2], /QA RUNS PASSED/);
    assert.match(lines[3], /\b3\/4\b.*\$0\.50/, "a run that couldn't run the tests reached no verdict");
    assert.match(trackRecordLines({ by: "model", since: null, rows: [] })[0], /^No jobs recorded yet/);
  });

  it("adds a table of plans and acceptance checks, for models that planned or reviewed", () => {
    const opus = { ...row("claude-opus-5-5", { finished: 0 }), builds: { ...row("x").builds, jobs: 0 }, tasks: { worked: 0, finished: 0, firstTry: 0, tookOver: 0 }, plans: { planned: 4, proposed: 3, approved: 2, rejected: 1, failed: 0, withQuestions: 2, costUsd: 1.6 }, reviews: { checks: 9, met: 7, unmet: 1, undecided: 1, costUsd: 0.45 } };
    const lines = trackRecordLines({ by: "model", since: null, rows: [row("gemini"), opus] });
    const work = lines.indexOf(lines.find((l) => l.startsWith("MODEL  "))!);
    assert.ok(!lines[work + 2]?.startsWith("claude-opus-5-5"), "a model that only planned and reviewed isn't in the work table");
    const plansHeader = lines.findIndex((l) => /^MODEL\s+PLANS\s+PROPOSED/.test(l));
    assert.ok(plansHeader > work);
    assert.match(lines[plansHeader + 1], /^claude-opus-5-5\s+4\s+3\s+2\s+1\s+2\s+\$1\.60\s+9\s+7\s+1\s+1\s+\$0\.45$/);
  });
});
