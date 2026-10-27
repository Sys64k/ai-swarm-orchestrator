import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { currentDeskModel, currentModels, defaultSince, modelName, modelSuggestions, roleEvidence, suggestFor } from "@aso/hub";
import { ModelSuggestionsSchema, type TrackRecordRow } from "@aso/shared";
import { TOKEN, withHub } from "./helpers.ts";

const call = (port: number, route: string) =>
  fetch(`http://127.0.0.1:${port}${route}`, { headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

/** A model's row with only what suggestions read. */
function row(key: string, r: { started?: [number, number, number]; reviews?: [number, number, number]; plans?: [number, number, number, number] } = {}): TrackRecordRow {
  const [settled, finished, startedCost] = r.started ?? [0, 0, 0];
  const [checks, overturned, checkCost] = r.reviews ?? [0, 0, 0];
  const [planned, proposed, approved, planCost] = r.plans ?? [0, 0, 0, 0];
  return {
    key,
    builds: { jobs: 0, built: 0, unverified: 0, failed: 0, outOfTurns: 0, modelRefused: 0, dropped: 0, cancelled: 0, qaPassed: 0, qaFailed: 0, accepted: 0, unmet: 0 },
    qaRuns: { runs: 0, passed: 0, failed: 0, errors: 0, dropped: 0 },
    tasks: { worked: 0, finished: 0, firstTry: 0, tookOver: 0 },
    costUsd: 0,
    started: { settled, finished, costUsd: startedCost, ...(finished ? { costPerFinishedUsd: startedCost / finished } : {}) },
    plans: { planned, proposed, approved, rejected: proposed - approved, failed: 0, withQuestions: 0, costUsd: planCost },
    reviews: { checks, met: checks, overturned, unmet: 0, undecided: 0, costUsd: checkCost },
  };
}

describe("model suggestions", () => {
  it("suggests a cheaper desk model that finishes about as many tasks", () => {
    const rows = [row("opus", { started: [20, 19, 38] }), row("gemini", { started: [20, 18, 20] }), row("haiku", { started: [20, 10, 5] })];
    const { suggestion } = suggestFor("desks", rows, "opus");
    assert.equal(suggestion?.kind, "cheaper");
    assert.equal(suggestion?.suggested.model, "gemini", "haiku is cheaper still, but finishes far fewer");
    assert.match(suggestion!.reason, /^gemini costs 44% less for about the same: \$1\.11 a finished task, 90% finished \(20 settled tasks\), against \$2\.00 a finished task, 95% finished/);
  });

  it("suggests a clearly better model even when it costs more, and keeps a model that's best", () => {
    const rows = [row("cheap", { reviews: [20, 6, 1] }), row("careful", { reviews: [20, 1, 4] })];
    const better = suggestFor("reviewer", rows, "cheap").suggestion!;
    assert.deepEqual([better.kind, better.suggested.model, better.suggested.quality], ["better", "careful", 0.95]);
    assert.match(better.reason, /held up/);
    assert.deepEqual(suggestFor("reviewer", rows, "careful"), { note: "careful is the best choice among the models with enough data." }, "cheap is cheaper, but far worse");
  });

  it("says what's missing instead of guessing", () => {
    const rows = [row("opus", { plans: [6, 5, 4, 3] }), row("sonnet", { plans: [2, 2, 2, 0.4] })];
    assert.deepEqual(suggestFor("architect", rows, "opus"), { note: "No other model has 5 proposed plans yet to compare opus with." });
    assert.deepEqual(suggestFor("architect", rows, "sonnet"), { note: "sonnet: 2 of 5 proposed plans needed to compare it." });
    assert.deepEqual(suggestFor("architect", rows, undefined), { note: "No model is set for it." });
    assert.deepEqual(suggestFor("desks", rows, undefined), { note: "No worker machine is connected right now, so no desk's model to compare." }, "after a Hub restart, before the workers are back");
    assert.deepEqual(suggestFor("desks", [], "gemini"), { note: "gemini: 0 of 10 settled tasks needed to compare it." });
    const alone = [row("gemini", { started: [12, 11, 12] })];
    assert.deepEqual(suggestFor("desks", alone, "gemini"), { note: "No other model has 10 settled tasks yet to compare gemini with. Put one on trial to get it: aso challenger desks <model>." });
  });

  it("reads each model's record in a role, leaving out models with none", () => {
    const records = { by: "model" as const, since: null, rows: [row("opus", { reviews: [4, 1, 0.4] }), row("gemini", { started: [5, 4, 4] })] };
    assert.deepEqual(roleEvidence(records, "reviewer").map((e) => [e.model, e.samples, e.quality]), [["opus", 4, 0.75]]);
    assert.deepEqual(roleEvidence(records, "desks").map((e) => e.model), ["gemini"]);
  });

  it("doesn't flip on small differences", () => {
    const rows = [row("a", { started: [20, 18, 20] }), row("b", { started: [20, 18, 18] }), row("c", { started: [20, 19, 20] })];
    assert.equal(suggestFor("desks", rows, "a").suggestion, undefined, "10% cheaper and 5 points better are both within the margins");
  });

  it("names models as track records do, and finds the desks' model in use", () => {
    const available = [{ model: "models/gemini-3.8-flash", spec: "gemini/models/gemini-3.8-flash" }];
    assert.equal(modelName("gemini/models/gemini-3.8-flash", available), "models/gemini-3.8-flash");
    assert.equal(modelName("anthropic/claude-opus-5-5", available), "claude-opus-5-5");
    assert.equal(modelName("claude-opus-5-5", available), "claude-opus-5-5");
    const own: Record<string, string> = { "avalon#1": "gemini/x", "avalon#2": "gemini/x" };
    assert.equal(currentDeskModel(["avalon#1", "avalon#2", "canfod#1"], (d) => own[d], "claude-haiku-5-5"), "gemini/x", "most desks");
    assert.equal(currentDeskModel([], () => undefined, "claude-haiku-5-5"), undefined, "no desks connected");
    const current = currentModels([{ hostname: "avalon", slots: 2 }, { hostname: "canfod", slots: 1 }], (d) => own[d], { defaultAgent: "claude-haiku-5-5", reviewer: "openai/gpt-6.1-sol", architect: null });
    assert.deepEqual(current, { desks: "gemini/x", reviewer: "openai/gpt-6.1-sol", architect: undefined });
    assert.equal(defaultSince(Date.parse("2026-10-31T00:00:00.000Z")), "2026-10-01T00:00:00.000Z", "the last 30 days");
  });

  it("gives each suggestion the spec to choose it by, and what applies it", () => {
    const records = { by: "model" as const, since: null, rows: [row("opus", { started: [20, 19, 38] }), row("models/gemini-3.8-flash", { started: [20, 18, 20] })] };
    const out = modelSuggestions(records, "2026-10-01T00:00:00.000Z", { desks: "anthropic/claude-opus-5-5", reviewer: undefined, architect: undefined }, [{ model: "models/gemini-3.8-flash", spec: "gemini/models/gemini-3.8-flash" }], ["avalon", "canfod"]);
    assert.ok(ModelSuggestionsSchema.safeParse(out).success);
    // "anthropic/claude-opus-5-5" is "claude-opus-5-5" by name, which has no row here.
    assert.deepEqual(out.notes.map((n) => n.role), ["desks", "reviewer", "architect"]);
    const named = modelSuggestions(records, "2026-10-01T00:00:00.000Z", { desks: "opus", reviewer: undefined, architect: undefined }, [{ model: "models/gemini-3.8-flash", spec: "gemini/models/gemini-3.8-flash" }], ["avalon", "canfod"]);
    assert.equal(named.suggestions[0].spec, "gemini/models/gemini-3.8-flash");
    assert.deepEqual(named.suggestions[0].apply, [
      { kind: "desk", target: "avalon", model: "gemini/models/gemini-3.8-flash" },
      { kind: "desk", target: "canfod", model: "gemini/models/gemini-3.8-flash" },
    ]);
    const reviewer = modelSuggestions(
      { by: "model", since: null, rows: [row("cheap", { reviews: [20, 6, 1] }), row("gpt-6.1-sol", { reviews: [20, 1, 4] })] },
      "2026-10-01T00:00:00.000Z",
      { desks: undefined, reviewer: "cheap", architect: undefined },
      [],
      ["avalon"],
    );
    assert.deepEqual([reviewer.suggestions[0].spec, reviewer.suggestions[0].apply], [undefined, []], "no provider offers it now: nothing to apply");
  });
});

describe("model suggestions (Hub)", () => {
  it("answers for the last 30 days by default, and refuses a bad time", () =>
    withHub(async (ctx) => {
      const r = await call(ctx.port, "/api/model-suggestions");
      assert.equal(r.status, 200);
      assert.ok(ModelSuggestionsSchema.safeParse(r.body).success);
      const days = (Date.now() - Date.parse(r.body.since)) / 86_400_000;
      assert.ok(days > 29.9 && days < 30.1, String(days));
      assert.equal((await call(ctx.port, "/api/model-suggestions?since=yesterday")).status, 400);
      assert.equal((await call(ctx.port, "/api/model-suggestions?since=2026-10-01")).body.since, "2026-10-01");
    }));
});
