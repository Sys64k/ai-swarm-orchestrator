import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCommands, tuneLines } from "../dist/commands/tune.js";

const evidence = (model: string, unitCostUsd: number) => ({ model, samples: 20, quality: 0.9, unitCostUsd });
const desks = {
  role: "desks" as const,
  kind: "cheaper" as const,
  current: evidence("claude-opus-5-5", 2),
  suggested: evidence("models/gemini-3.8-flash", 1.1),
  spec: "gemini/models/gemini-3.8-flash",
  apply: ["avalon", "canfod"].map((target) => ({ kind: "desk" as const, target, model: "gemini/models/gemini-3.8-flash" })),
  reason: "models/gemini-3.8-flash costs 45% less for about the same.",
};

describe("aso tune", () => {
  it("says each suggestion and the commands that apply it", () => {
    const lines = tuneLines({ since: "2026-10-01T00:00:00.000Z", suggestions: [desks], notes: [{ role: "reviewer", text: "gpt-6.1-sol: 3 of 10 met verdicts needed to compare it." }] });
    assert.deepEqual(lines, [
      "Model suggestions from jobs since 2026-10-01T00:00:00.000Z:",
      "",
      "Desks: models/gemini-3.8-flash instead of claude-opus-5-5 (cheaper).",
      "  models/gemini-3.8-flash costs 45% less for about the same.",
      "  To apply:",
      "    aso desk avalon gemini/models/gemini-3.8-flash",
      "    aso desk canfod gemini/models/gemini-3.8-flash",
      "",
      "Reviewer: gpt-6.1-sol: 3 of 10 met verdicts needed to compare it.",
    ]);
  });

  it("applies a role by name, and says when no provider offers the model now", () => {
    assert.deepEqual(applyCommands({ ...desks, role: "reviewer", spec: "openai/gpt-6.1-sol", apply: [{ kind: "role", target: "reviewer", model: "openai/gpt-6.1-sol" }] }), ["aso desk reviewer openai/gpt-6.1-sol"]);
    const gone = tuneLines({ since: "x", suggestions: [{ ...desks, spec: undefined, apply: [] }], notes: [] });
    assert.match(gone.join("\n"), /No provider offers it now/);
    assert.match(tuneLines({ since: "x", suggestions: [], notes: [] }).join("\n"), /No suggestions\./);
  });
});
