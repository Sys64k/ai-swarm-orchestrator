import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelLines } from "../dist/commands/models.js";

describe("aso models", () => {
  it("shows the Architect, the default, each profile and its desks", () => {
    const lines = modelLines({
      architect: "claude-opus-5-5",
      defaultAgent: "claude-haiku-5-5",
      profiles: [{ name: "local", model: "openai:qwen3-coder:30b", baseUrl: "http://avalon:11434/v1", concurrency: 1, running: 1, waiting: 2 }],
      desks: [{ desk: "avalon#1", profile: "local" }],
    });
    assert.deepEqual(lines, [
      "Architect: claude-opus-5-5",
      "Desks without a profile: claude-haiku-5-5",
      "",
      "Profiles:",
      "  local: openai:qwen3-coder:30b at http://avalon:11434/v1, 1 at once (1 running, 2 waiting)",
      "",
      "Desks:",
      "  avalon#1: local",
    ]);
  });

  it("says how to add a profile when there are none", () => {
    const lines = modelLines({ architect: "a", defaultAgent: "b", profiles: [], desks: [] });
    assert.match(lines.at(-1)!, /aso model-profile set <name> <model>/);
  });
});
