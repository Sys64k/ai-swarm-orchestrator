import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { poolLines } from "../dist/commands/pool.js";

const terra = { model: "openai/gpt-6.1-terra", share: 0.3, budgetUsd: 20, since: "x", samples: 3, needed: 10, spentUsd: 4.2 };

describe("aso pool", () => {
  it("shows each role's own model and members with their shares, then the latest changes", () => {
    const lines = poolLines({
      roles: {
        desks: { base: "gemini/models/gemini-3.8-flash", baseShare: 0.7, members: [terra], auto: true, candidates: ["anthropic/claude-sonnet-5-5"] },
        reviewer: { base: "openai/gpt-6.1-sol", baseShare: 1, members: [], auto: false, candidates: [] },
      },
      log: [{ at: "2026-10-28T09:15:00.000Z", role: "desks", text: "started trying openai/gpt-6.1-terra on 20% of the work, up to $20" }],
    });
    assert.deepEqual(lines, [
      "Desks (auto-tuning on):",
      "  gemini/models/gemini-3.8-flash: 70% (its own model)",
      "  openai/gpt-6.1-terra: 30%, 3 of 10 samples, $4.20 of $20",
      "  next to try: anthropic/claude-sonnet-5-5",
      "Reviewer (auto-tuning off):",
      "  openai/gpt-6.1-sol: 100% (its own model)",
      "",
      "Latest changes:",
      "  2026-10-28 09:15 desks: started trying openai/gpt-6.1-terra on 20% of the work, up to $20",
    ]);
  });
});
