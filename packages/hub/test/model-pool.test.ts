import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseShare, desksOnModel, hashUnit, memberFor, MIN_KEEP_SHARE, nextCandidate, rebalance, takesWork, type PoolMember } from "@aso/hub";
import type { SuggestionEvidence, Trial } from "@aso/shared";

const NOW = "2026-10-28T00:00:00.000Z";
const member = (spec: string, share: number, status: Partial<Trial> = {}): PoolMember => ({
  member: { spec, share, budgetUsd: 20, since: "2026-10-27T00:00:00.000Z" },
  status: { model: spec, share, budgetUsd: 20, since: "2026-10-27T00:00:00.000Z", samples: 0, needed: 10, spentUsd: 0, ...status },
});
const evidence = (model: string, quality: number, unitCostUsd: number, samples = 20): SuggestionEvidence => ({ model, samples, quality, unitCostUsd });
const name = (spec: string) => spec;

describe("the model pool", () => {
  it("gives each member its share of the tasks, in order, and the rest to the base", () => {
    const pool = [member("a", 0.2), member("b", 0.3)];
    const ids = Array.from({ length: 3000 }, (_, i) => `t${i}`);
    const counts = { a: 0, b: 0, base: 0 };
    for (const id of ids) counts[(memberFor("desks", pool, false, id) as "a" | "b" | undefined) ?? "base"]++;
    assert.ok(Math.abs(counts.a / 3000 - 0.2) < 0.03 && Math.abs(counts.b / 3000 - 0.3) < 0.03, JSON.stringify(counts));
    const id = ids.find((t) => hashUnit(`desks:${t}`) < 0.2)!;
    assert.equal(memberFor("desks", pool, false, id), "a", "the first member takes the lowest places");
  });

  it("keeps a member with enough data taking work only with auto-tuning; a spent one never", () => {
    const done = member("a", 0.2, { samples: 10, ended: "enough data" });
    assert.deepEqual([takesWork(done, false), takesWork(done, true)], [false, true]);
    assert.equal(takesWork(member("a", 0.2, { ended: "budget spent" }), true), false);
    assert.equal(takesWork(member("a", 0.2), false), true, "still exploring");
  });

  it("moves shares a step toward the cheapest model that is good enough", () => {
    const r = rebalance("desks", "gemini", [member("terra", 0.3, { samples: 10 })], [evidence("gemini", 0.9, 1.3), evidence("terra", 0.85, 0.9)], name, NOW);
    assert.deepEqual(r.members.map((m) => [m.spec, m.share]), [["terra", 0.45]], "terra is 5 points worse (within 10) and cheaper: +15");
    assert.match(r.log[0], /terra: 30% → 45% \(\$0\.90 a unit, 85%, the cheapest good enough\)/);
    assert.equal(r.promote, undefined, "the base still takes 55%");
  });

  it("drops a member clearly worse than the best, and one that spent its budget exploring", () => {
    const r = rebalance(
      "desks",
      "gemini",
      [member("cheap", 0.2, { samples: 10 }), member("broke", 0.2, { ended: "budget spent" }), member("new", 0.2)],
      [evidence("gemini", 0.9, 1.3), evidence("cheap", 0.6, 0.4)],
      name,
      NOW,
    );
    assert.deepEqual(r.members.map((m) => m.spec), ["new"], "only the one still exploring stays");
    assert.ok(r.log.some((l) => /cheap dropped: 60% against the best's 90%/.test(l)));
    assert.ok(r.log.some((l) => /broke spent its \$20 budget before it had 10 samples: dropped/.test(l)));
  });

  it("shrinks a good-enough member that isn't the cheapest, but keeps it in", () => {
    const r = rebalance("reviewer", "sol", [member("opus", 0.3, { samples: 10 })], [evidence("sol", 0.95, 0.05), evidence("opus", 0.97, 0.4)], name, NOW);
    assert.deepEqual(r.members.map((m) => m.share), [0.15]);
    const low = rebalance("reviewer", "sol", [member("opus", 0.12, { samples: 10 })], [evidence("sol", 0.95, 0.05), evidence("opus", 0.97, 0.4)], name, NOW);
    assert.deepEqual(low.members.map((m) => m.share), [MIN_KEEP_SHARE], "never below the minimum while good enough");
  });

  it("makes a member that overtakes the base the new base, and the old base a member", () => {
    const r = rebalance("desks", "gemini", [member("terra", 0.45, { samples: 10 })], [evidence("gemini", 0.9, 1.3), evidence("terra", 0.9, 0.9)], name, NOW);
    assert.equal(r.promote, "terra", "60% against 40%");
    assert.deepEqual(r.members, [{ spec: "gemini", share: 0.4, budgetUsd: 20, since: NOW }]);
    assert.match(r.log.at(-1)!, /terra now takes 60% against gemini's 40%: it becomes the base/);
  });

  it("changes nothing until two models can be compared", () => {
    const pool = [member("terra", 0.3, { samples: 4 })];
    assert.deepEqual(rebalance("desks", "gemini", pool, [evidence("gemini", 0.9, 1.3)], name, NOW), { members: [pool[0].member], log: [] });
    assert.deepEqual(rebalance("desks", "gemini", [member("terra", 0.3, { samples: 10 })], [evidence("terra", 0.9, 0.9)], name, NOW).log, [], "the base has too little data");
  });

  it("starts the next queued candidate while fewer than two explore and there's room", () => {
    const none = () => false;
    assert.equal(nextCandidate(["terra", "sonnet"], [], none), "terra");
    assert.equal(nextCandidate(["terra", "sonnet"], [member("terra", 0.2)], none), "sonnet", "one already in");
    assert.equal(nextCandidate(["x"], [member("a", 0.2), member("b", 0.2)], none), undefined, "two exploring");
    assert.equal(nextCandidate(["x"], [member("a", 0.2), member("b", 0.2)], (s) => s === "a"), "x", "a has its data: only one explores");
    assert.equal(nextCandidate(["x"], [member("a", 0.8)], () => true), undefined, "no room: 80% + 20% is over 90%");
  });

  it("says what the base takes, and which desks switch with it", () => {
    assert.equal(baseShare([member("a", 0.2), member("b", 0.3, { ended: "budget spent" })], true), 0.8, "a spent member takes nothing");
    const own: Record<string, string> = { "avalon#1": "gemini", "avalon#2": "local" };
    assert.deepEqual(desksOnModel(["avalon#1", "avalon#2", "canfod#1"], (d) => own[d], "gemini", "gemini"), ["avalon#1", "canfod#1"], "a desk on its own other model keeps it");
  });
});
