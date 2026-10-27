import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePublicStats } from "@aso/shared";

describe("aso start-hub --public-stats", () => {
  it("reads what to share", () => {
    assert.equal(parsePublicStats(undefined, undefined), undefined, "off by default");
    assert.equal(parsePublicStats("  ", "aso-ui"), undefined);
    assert.deepEqual(parsePublicStats("totals", undefined), { parts: [] });
    assert.deepEqual(parsePublicStats("models, costs", "aso-ui,blog"), { parts: ["models", "costs"], projects: ["aso-ui", "blog"] });
    assert.throws(() => parsePublicStats("models,machines", undefined), /unknown machines \(use totals, or any of models, costs\)/);
  });
});
