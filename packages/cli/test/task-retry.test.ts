import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { criteriaFromText, retryBodyFromOptions } from "../dist/commands/task-retry.js";

describe("aso task-retry", () => {
  it("reads criteria one per line, with or without list markers", () => {
    assert.deepEqual(criteriaFromText("- keeps the order\n\n2. no sideways scroll\n  * checks at 3440px  \n"), ["keeps the order", "no sideways scroll", "checks at 3440px"]);
  });

  it("sends only the corrections given, and refuses criteria given twice", () => {
    assert.deepEqual(retryBodyFromOptions({}), {}, "a plain retry");
    assert.deepEqual(retryBodyFromOptions({ description: "New", criterion: ["a", "b"] }), { description: "New", acceptanceCriteria: ["a", "b"] });
    assert.deepEqual(retryBodyFromOptions({}, "- a\n- b"), { acceptanceCriteria: ["a", "b"] });
    assert.throws(() => retryBodyFromOptions({ criterion: ["a"] }, "b"), /not both/);
  });
});
