import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deskLines, modelLines } from "../dist/commands/models.js";

describe("aso models and aso desks", () => {
  it("lists the models to choose from, Claude and local", () => {
    const lines = modelLines({
      architect: "claude-opus-5-5",
      defaultAgent: "claude-haiku-5-5",
      available: [
        { model: "claude-haiku-5-5", spec: "claude-haiku-5-5", provider: "anthropic" },
        { model: "qwen3-coder:30b", spec: "openai:qwen3-coder:30b", provider: "openai-compatible", baseUrl: "http://avalon:11434/v1" },
      ],
    });
    assert.deepEqual(lines.slice(0, 7), [
      "Architect: claude-opus-5-5",
      "Desks without a model of their own: claude-haiku-5-5",
      "",
      "Claude:",
      "  claude-haiku-5-5",
      "Local (http://avalon:11434/v1):",
      "  qwen3-coder:30b",
    ]);
    assert.match(modelLines({ architect: null, defaultAgent: null, available: [], localError: "x can't be reached" }).join("\n"), /Local models: x can't be reached/);
  });

  it("shows each desk's model and each model's load", () => {
    assert.deepEqual(
      deskLines({
        architect: "claude-opus-5-5",
        defaultAgent: "claude-haiku-5-5",
        desks: [{ desk: "avalon#4", model: "openai:qwen3-coder:30b" }],
        models: [{ model: "openai:qwen3-coder:30b", concurrency: 1, running: 1, waiting: 2 }],
      }),
      ["Desks without a model of their own: claude-haiku-5-5", "", "  avalon#4: openai:qwen3-coder:30b", "", "openai:qwen3-coder:30b: 1 call at once, 1 running, 2 waiting"],
    );
    assert.match(deskLines({ architect: null, defaultAgent: "x", desks: [], models: [] }).join("\n"), /Every desk uses it/);
  });
});
