import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deskLines, escalationLines, modelLines, ownModelLines, trialLines } from "../dist/commands/models.js";

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

  it("says where failing tasks move, and whether that was changed while the Hub runs", () => {
    assert.deepEqual(escalationLines({ escalation: { ladder: ["anthropic/claude-opus-5-5"], juniorTries: 2 }, escalationSet: {} }), [
      "Escalation: after 2 tries on a desk's model, to anthropic/claude-opus-5-5",
    ]);
    assert.deepEqual(escalationLines({ escalation: { ladder: ["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"], juniorTries: 1 }, escalationSet: { juniorTries: 1 } }), [
      "Escalation: after 1 try on a desk's model, to openai/gpt-6.1-sol, then anthropic/claude-opus-5-5 (changed with `aso escalation`)",
    ]);
    assert.deepEqual(escalationLines({ escalation: null, escalationSet: {} }), ["Escalation: off (every round on the desk's model)"]);
    assert.deepEqual(escalationLines({} as never), [], "an older Hub doesn't say");
    const lines = deskLines({ architect: "a", reviewer: "a", escalation: { ladder: ["b"], juniorTries: 2 }, escalationSet: {}, defaultAgent: "x", desks: [], models: [] });
    assert.equal(lines[2], "Escalation: after 2 tries on a desk's model, to b", "aso desks shows it under the roles");
  });

  it("shows each trial: its model, share, data so far and spending", () => {
    const t = { model: "openai/gpt-6.1-terra", share: 0.1, budgetUsd: 5, since: "x", samples: 3, needed: 10, spentUsd: 0.8 };
    assert.deepEqual(trialLines({ challengers: { desks: t, reviewer: { ...t, model: "openai/gpt-6.1-sol", samples: 10, ended: "enough data" } } }), [
      "On trial for the desks: openai/gpt-6.1-terra, 10% of the work, 3 of 10 settled tasks, $0.80 of $5",
      "On trial for the reviewer: openai/gpt-6.1-sol, 10% of the work, 10 of 10 met verdicts, $0.80 of $5 (ended: enough data)",
    ]);
    assert.deepEqual(trialLines({}), [], "an older Hub, or no trials");
  });
});
