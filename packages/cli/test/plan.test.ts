import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approvalAnswer } from "../dist/commands/plan.js";

describe("aso plan approval prompt", () => {
  it("approves on y, rejects on n or nothing, and treats anything else as changes", () => {
    for (const a of ["y", "Y", "yes", " YES "]) assert.equal(approvalAnswer(a), "approve", a);
    for (const a of ["", "  ", "n", "N", "no"]) assert.equal(approvalAnswer(a), "reject", JSON.stringify(a));
    for (const a of ["use SQLite", "yes but split the UI", "nope, add tests"]) assert.equal(approvalAnswer(a), "changes", a);
  });
});
