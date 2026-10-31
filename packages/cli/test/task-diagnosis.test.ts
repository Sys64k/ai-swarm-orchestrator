import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnosisText } from "../dist/commands/task-diagnosis.js";

const ready = {
  attempt: 0,
  state: "ready" as const,
  at: "2026-10-31T10:00:00.000Z",
  model: "claude-opus-5-5",
  costUsd: 0.214,
  cause: "task" as const,
  summary: "The criterion contradicted the sort order.",
  evidence: [
    { source: "acceptance" as const, quote: "sorted by id", note: "what the reviewer saw", found: true },
    { source: "transcript" as const, quote: "made up", found: false },
  ],
  proposal: { action: "retry_with_correction" as const, why: "Ask for the order the code has.", acceptanceCriteria: ["Sorted by id"] },
};

describe("aso task-diagnosis", () => {
  it("prints the cause, the evidence with unfound quotes marked, and the proposal to answer", () => {
    assert.equal(
      diagnosisText({ state: "failed", diagnosis: ready }),
      [
        "The task was wrong or unclear",
        "The criterion contradicted the sort order.",
        "",
        "  [Acceptance check] sorted by id\n    what the reviewer saw",
        "! [Transcript] made up",
        "  (! = the Hub didn't find this quote in that source)",
        "",
        "Proposes: Retry it with the task corrected. Ask for the order the code has.",
        "  - Sorted by id",
        "",
        "answer with --accept or --refuse",
        "claude-opus-5-5 · $0.21",
      ].join("\n"),
    );
  });

  it("says when there's nothing to answer", () => {
    assert.match(diagnosisText({ state: "failed" }), /`--again` asks/);
    assert.match(diagnosisText({ state: "merged" }), /only failed tasks/);
    assert.match(diagnosisText({ state: "failed", diagnosis: { attempt: 0, state: "diagnosing", at: "x" } }), /reading/);
    assert.match(diagnosisText({ state: "failed", diagnosis: { attempt: 0, state: "failed", at: "x", error: "no model" } }), /couldn't diagnose it: no model/);
    assert.match(diagnosisText({ state: "failed", diagnosis: { ...ready, decision: { kind: "refused", at: "x" } } }), /you refused it/);
    assert.match(diagnosisText({ state: "pending", retries: 1, diagnosis: ready }), /of an earlier failure/);
  });
});
