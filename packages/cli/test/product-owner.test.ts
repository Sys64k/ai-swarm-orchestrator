import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productOwnerText } from "../dist/commands/product-owner.js";

const zero = { proposed: 0, accepted: 0, refused: 0 };
const record = {
  diagnosed: 4,
  couldNot: 1,
  costUsd: 0.8,
  decisions: { accepted: 2, refused: 1, waiting: 1, unanswered: 0 },
  causes: { task: 3, model: 1, platform: 0, unclear: 0 },
  actions: { retry_with_correction: { proposed: 3, accepted: 2, refused: 1 }, retry: zero, dismiss: { proposed: 1, accepted: 0, refused: 0 }, platform_issue: zero, none: zero },
  retries: { accepted: 2, merged: 1, failedAgain: 0, underway: 1 },
  quotes: { total: 9, notFound: 2 },
};

describe("aso product-owner", () => {
  it("prints its record in plain words", () => {
    assert.equal(
      productOwnerText(record),
      [
        "read:       4 failures (couldn't read 1), $0.80",
        "answered:   2 accepted, 1 refused, 1 waiting for you, 0 never answered",
        "retries:    2 accepted: 1 merged, 0 failed again, 1 still going",
        "quotes:     2 of 9 not found in their source",
        "",
        "causes:",
        "  3  The task was wrong or unclear",
        "  1  The model couldn't do it",
        "proposals (accepted / refused):",
        "  3  Retry it with the task corrected (2 / 1)",
        "  1  Dismiss it (0 / 0)",
      ].join("\n"),
    );
  });

  it("says when it has read nothing", () => {
    assert.equal(productOwnerText({ ...record, diagnosed: 0, couldNot: 0 }), "the product owner hasn't read any failures yet");
    assert.match(productOwnerText({ ...record, diagnosed: 0 }), /couldn't read 1/);
  });
});
