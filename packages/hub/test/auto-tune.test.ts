import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeskModels, tuneRole, tuningChangeText, type LlmAdapter, type PoolMember, type TunerDeps } from "@aso/hub";
import type { SuggestionEvidence } from "@aso/shared";
import { reply, text } from "./helpers.ts";

const NOW = new Date("2026-10-28T00:00:00.000Z");
const fake = (spec: string): LlmAdapter => ({ name: "fake", model: spec, complete: async () => reply([text("ok")], "end_turn") });

/** A tuner over a real model store (in memory), with the rest given. */
async function tuner(opts: { evidence?: SuggestionEvidence[]; base?: string; refuse?: string } = {}) {
  const models = await DeskModels.open(undefined, fake, 4, () => false, async (a) => {
    if (a.model === opts.refuse) throw new Error("can't take tools");
  });
  const promoted: string[] = [];
  const notes: string[] = [];
  const deps: TunerDeps = {
    models,
    poolOf: (role) => models.members(role).map((member): PoolMember => ({ member, status: { model: member.spec, share: member.share, budgetUsd: member.budgetUsd, since: member.since, samples: 10, needed: 10, spentUsd: 0 } })),
    evidence: () => opts.evidence ?? [],
    base: () => opts.base,
    nameOf: (s) => s,
    promote: async (_role, spec, from) => void promoted.push(`${from} -> ${spec}`),
    notify: (title, body) => void notes.push(`${title}: ${body}`),
    now: () => NOW,
  };
  return { models, deps, promoted, notes };
}

describe("auto-tuning", () => {
  it("says a person's change in a line for the log", () => {
    assert.equal(tuningChangeText({ auto: true, candidates: ["a", "b"] }), "auto-tuning on; candidates: a, b");
    assert.equal(tuningChangeText({ candidates: [] }), "candidates: none");
  });

  it("does nothing while it's off", async () => {
    const t = await tuner({ base: "gemini" });
    await t.models.setTuning("desks", { candidates: ["terra"] });
    await tuneRole("desks", t.deps);
    assert.deepEqual([t.models.members("desks").length, t.notes.length], [0, 0]);
  });

  it("starts the next candidate, and skips one that can't be tried, saying so", async () => {
    const t = await tuner({ base: "gemini", refuse: "broken" });
    await t.models.setTuning("desks", { auto: true, candidates: ["broken", "terra"] });
    await tuneRole("desks", t.deps);
    assert.deepEqual(t.models.members("desks"), [], "broken refused");
    assert.deepEqual(t.models.tuning("desks").candidates, ["terra"]);
    assert.match(t.models.tuningEntries().at(-1)!.text, /can't try broken: can't take tools/);
    await tuneRole("desks", t.deps);
    assert.deepEqual(t.models.members("desks").map((m) => [m.spec, m.share, m.budgetUsd]), [["terra", 0.2, 20]]);
    assert.deepEqual(t.models.tuning("desks").candidates, []);
    assert.match(t.notes.at(-1)!, /Model mix for the desks changed: started trying terra on 20% of the work, up to \$20/);
  });

  it("rebalances every few new samples, and switches the base when a member overtakes it", async () => {
    const evidence = [
      { model: "gemini", samples: 10, quality: 0.9, unitCostUsd: 1.3 },
      { model: "terra", samples: 10, quality: 0.9, unitCostUsd: 0.9 },
    ];
    const t = await tuner({ base: "gemini", evidence });
    await t.models.setTuning("desks", { auto: true, lastSamples: 18 });
    await t.models.setChallenger("desks", "terra", { share: 0.45, budgetUsd: 20, maxShare: 0.9 });
    await tuneRole("desks", t.deps);
    assert.deepEqual(t.models.members("desks").map((m) => m.share), [0.45], "2 new samples: not yet");
    await t.models.setTuning("desks", { lastSamples: 15 });
    await tuneRole("desks", t.deps);
    assert.deepEqual(t.promoted, ["gemini -> terra"]);
    assert.deepEqual(t.models.members("desks").map((m) => [m.spec, m.share]), [["gemini", 0.4]]);
    assert.equal(t.models.tuning("desks").lastSamples, 20);
    assert.ok(t.models.tuningEntries().some((e) => /terra now takes 60%/.test(e.text)));
  });
});
