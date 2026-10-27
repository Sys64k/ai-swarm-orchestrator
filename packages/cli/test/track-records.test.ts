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
});
