import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productOwnerRecord, retryOutcome, withDiagnosis } from "@aso/hub";
import { PAST_DIAGNOSES, type Diagnosis } from "@aso/shared";

const at = "2026-10-31T10:00:00.000Z";
const ready = (extra: Partial<Diagnosis> = {}): Diagnosis => ({
  attempt: 0,
  state: "ready",
  at,
  costUsd: 0.2,
  cause: "task",
  evidence: [
    { source: "diff", quote: "a", found: true },
    { source: "transcript", quote: "b", found: false },
  ],
  proposal: { action: "retry_with_correction", why: "w", acceptanceCriteria: ["c"] },
  ...extra,
});
const accepted = { kind: "accepted" as const, at };
const task = (state: string, extra: Record<string, unknown> = {}) => ({ project: "shop", state, ...extra }) as Parameters<typeof productOwnerRecord>[0][number];

describe("the product owner's track record", () => {
  it("says whether an accepted retry worked", () => {
    assert.equal(retryOutcome({ state: "merged", retries: 1 }, { attempt: 0 }), "merged");
    assert.equal(retryOutcome({ state: "in_progress", retries: 1 }, { attempt: 0 }), "underway");
    assert.equal(retryOutcome({ state: "failed", retries: 1 }, { attempt: 0 }), "failedAgain");
    assert.equal(retryOutcome({ state: "cancelled", retries: 1 }, { attempt: 0 }), "failedAgain");
    assert.equal(retryOutcome({ state: "merged", retries: 2 }, { attempt: 0 }), "failedAgain", "it took another retry after that one");
  });

  it("counts what it read, what people did with it, and what came of it", () => {
    const tasks = [
      // Accepted, retried, merged.
      task("merged", { retries: 1, diagnosis: ready({ decision: accepted }) }),
      // Accepted, failed again, and read again: the new one waits.
      task("failed", { retries: 1, pastDiagnoses: [ready({ decision: accepted })], diagnosis: ready({ attempt: 1, cause: "model", proposal: { action: "dismiss", why: "w" } }) }),
      // Refused.
      task("failed", { diagnosis: ready({ cause: "platform", proposal: { action: "platform_issue", why: "w" }, decision: { kind: "refused", at } }) }),
      // Nobody answered before it was retried by hand.
      task("in_progress", { retries: 1, diagnosis: ready({ proposal: { action: "retry", why: "w" } }) }),
      // Couldn't be read.
      task("failed", { diagnosis: { attempt: 0, state: "failed", at, error: "budget spent" } }),
      task("merged"),
    ];
    assert.deepEqual(productOwnerRecord(tasks), {
      diagnosed: 5,
      couldNot: 1,
      costUsd: 1,
      decisions: { accepted: 2, refused: 1, waiting: 1, unanswered: 1 },
      causes: { task: 3, model: 1, platform: 1, unclear: 0 },
      actions: {
        retry_with_correction: { proposed: 2, accepted: 2, refused: 0 },
        retry: { proposed: 1, accepted: 0, refused: 0 },
        dismiss: { proposed: 1, accepted: 0, refused: 0 },
        platform_issue: { proposed: 1, accepted: 0, refused: 1 },
        none: { proposed: 0, accepted: 0, refused: 0 },
      },
      retries: { accepted: 2, merged: 1, failedAgain: 1, underway: 0 },
      quotes: { total: 10, notFound: 5 },
    });
  });

  it("keeps to one project and a period", () => {
    const tasks = [task("merged", { retries: 1, diagnosis: ready({ decision: accepted }) }), { ...task("failed", { diagnosis: ready({ at: "2026-10-01T00:00:00.000Z" }) }), project: "blog" }];
    assert.equal(productOwnerRecord(tasks, { project: "blog" }).diagnosed, 1);
    assert.equal(productOwnerRecord(tasks, { since: "2026-10-15" }).diagnosed, 1);
    assert.equal(productOwnerRecord(tasks, { project: "blog", since: "2026-10-15" }).diagnosed, 0);
  });
});

describe("withDiagnosis", () => {
  it("keeps readings of earlier failures, and replaces one of the same failure", () => {
    const first = ready({ decision: accepted });
    const second = ready({ attempt: 1 });
    assert.deepEqual(withDiagnosis({ diagnosis: first }, second), { diagnosis: second, pastDiagnoses: [first] });
    assert.deepEqual(withDiagnosis({ diagnosis: first }, ready()), { diagnosis: ready(), pastDiagnoses: undefined }, "asked again about the same failure");
    const couldNot: Diagnosis = { attempt: 0, state: "failed", at, error: "x" };
    assert.deepEqual(withDiagnosis({ diagnosis: couldNot }, second), { diagnosis: second, pastDiagnoses: undefined }, "nothing to keep");
    const many = Array.from({ length: PAST_DIAGNOSES }, (_, i) => ready({ attempt: i }));
    const kept = withDiagnosis({ diagnosis: ready({ attempt: 10 }), pastDiagnoses: many }, ready({ attempt: 11 })).pastDiagnoses!;
    assert.equal(kept.length, PAST_DIAGNOSES);
    assert.deepEqual([kept[0].attempt, kept.at(-1)!.attempt], [1, 10], "the oldest goes");
  });
});
