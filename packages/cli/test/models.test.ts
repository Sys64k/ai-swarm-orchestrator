import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deskLines, modelLines, ownModelLines } from "../dist/commands/models.js";

describe("aso models and aso desks", () => {
  it("lists the models by provider, each by the spec a desk is put on", () => {
    const lines = modelLines({
      architect: "claude-opus-5-5",
      defaultAgent: "claude-haiku-5-5",
      available: [
        { model: "claude-haiku-5-5", spec: "anthropic/claude-haiku-5-5", provider: "anthropic", providerId: "anthropic", providerLabel: "Anthropic" },
        { model: "gpt-5", spec: "openai/gpt-5", provider: "openai-compatible", providerId: "openai", providerLabel: "OpenAI" },
        { model: "gpt-5-mini", spec: "openai/gpt-5-mini", provider: "openai-compatible", providerId: "openai", providerLabel: "OpenAI" },
        { model: "qwen3-coder:30b", spec: "local/qwen3-coder:30b", provider: "openai-compatible", providerId: "local", providerLabel: "Local (avalon:11434)" },
      ],
    });
    assert.deepEqual(lines.slice(0, 10), [
      "Architect: claude-opus-5-5",
      "Desks without a model of their own: claude-haiku-5-5",
      "",
      "Anthropic (anthropic):",
      "  anthropic/claude-haiku-5-5",
      "OpenAI (openai):",
      "  openai/gpt-5",
      "  openai/gpt-5-mini",
      "Local (avalon:11434) (local):",
      "  local/qwen3-coder:30b",
    ]);
    const none = modelLines({ architect: null, defaultAgent: null, available: [], localError: "OpenAI: HTTP 401" }).join("\n");
    assert.match(none, /No models: add a provider/);
    assert.match(none, /Couldn't list: OpenAI: HTTP 401/);
  });

  it("lists the machines that serve their own models", () => {
    const hw = (hostname: string) => ({ hostname }) as never;
    assert.deepEqual(ownModelLines([{ hardware: hw("avalon"), localModels: [{ id: "qwen3-coder:30b" }, { id: "llama3" }], defaultLocalModel: "llama3" }, { hardware: hw("canfod") }]), [
      "",
      "Machines' own models (machine/<model>):",
      "  avalon serves its own: qwen3-coder:30b, llama3 (its desks use llama3, free, unless put on another model)",
    ]);
    assert.deepEqual(ownModelLines([{ hardware: hw("canfod") }]), [], "none: nothing to add");
  });

  it("shows each desk's model and each model's load", () => {
    assert.deepEqual(
      deskLines({
        architect: "claude-opus-5-5",
        defaultAgent: "claude-haiku-5-5",
        desks: [{ desk: "avalon#4", model: "openai:qwen3-coder:30b" }],
        models: [{ model: "openai:qwen3-coder:30b", concurrency: 1, running: 1, waiting: 2 }],
      }),
      [
        "Architect: claude-opus-5-5",
        "Reviewer (acceptance check): claude-opus-5-5 (the Architect's)",
        "Desks without a model of their own: claude-haiku-5-5",
        "",
        "  avalon#4: openai:qwen3-coder:30b",
        "",
        "openai:qwen3-coder:30b: 1 call at once, 1 running, 2 waiting",
      ],
      "an older Hub sends no reviewer: the Architect's model",
    );
    assert.equal(deskLines({ architect: "claude-opus-5-5", reviewer: "anthropic/claude-sonnet-5-5", defaultAgent: "x", desks: [], models: [] })[1], "Reviewer (acceptance check): anthropic/claude-sonnet-5-5");
    assert.match(deskLines({ architect: null, defaultAgent: "x", desks: [], models: [] }).join("\n"), /Every desk uses it/);
  });
});
