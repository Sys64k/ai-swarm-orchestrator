import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hubPath } from "../lib/hub-routes.ts";
import type { Desks, Models, Provider } from "../lib/types.ts";
import {
  canonicalSpec,
  choiceGroups,
  deskModelChoices,
  deskModelOf,
  keyTravelsInClear,
  machineModelOf,
  priceBody,
  priceLine,
  providerBody,
  providerDetail,
  providerId,
} from "../lib/view.ts";

const models: Models = {
  architect: "claude-opus-5-5",
  defaultAgent: "claude-haiku-5-5",
  available: [
    { model: "claude-haiku-5-5", spec: "anthropic/claude-haiku-5-5", provider: "anthropic", providerId: "anthropic", providerLabel: "Anthropic" },
    { model: "qwen3-coder:30b", spec: "local/qwen3-coder:30b", provider: "openai-compatible", providerId: "local", providerLabel: "Local (avalon:11434)" },
    { model: "gpt-5", spec: "openai/gpt-5", provider: "openai-compatible", providerId: "openai", providerLabel: "OpenAI" },
  ],
};
const desks: Desks = {
  architect: "claude-opus-5-5",
  defaultAgent: "claude-haiku-5-5",
  desks: [
    { desk: "avalon#1", model: "openai:qwen3-coder:30b" },
    { desk: "avalon#2", model: "local/llama3.3:70b" },
  ],
  models: [],
};

describe("models per desk in the console", () => {
  it("offers the default, then each provider's models by spec, and a model a desk uses that isn't listed", () => {
    assert.deepEqual(deskModelChoices(models, desks), [
      { value: "default", label: "Default (claude-haiku-5-5)" },
      { value: "anthropic/claude-haiku-5-5", label: "claude-haiku-5-5", group: "Anthropic" },
      { value: "local/qwen3-coder:30b", label: "qwen3-coder:30b", group: "Local (avalon:11434)" },
      { value: "openai/gpt-5", label: "gpt-5", group: "OpenAI" },
      { value: "local/llama3.3:70b", label: "local/llama3.3:70b (not listed)", group: "Not listed" },
    ]);
  });

  it("groups the choices by provider, the default first", () => {
    const groups = choiceGroups(deskModelChoices(models, desks));
    assert.deepEqual(groups.map((g) => [g.group ?? null, g.choices.length]), [[null, 1], ["Anthropic", 1], ["Local (avalon:11434)", 1], ["OpenAI", 1], ["Not listed", 1]]);
  });

  it("reads older desk specs the way the Hub does", () => {
    assert.equal(canonicalSpec("openai:qwen3-coder:30b"), "local/qwen3-coder:30b");
    assert.equal(canonicalSpec("claude-haiku-5-5"), "anthropic/claude-haiku-5-5");
    assert.equal(canonicalSpec("openrouter/meta-llama/llama-3.3-70b"), "openrouter/meta-llama/llama-3.3-70b");
  });

  it("shows each desk's choice by its spec", () => {
    assert.equal(deskModelOf(desks, "avalon", 1), "local/qwen3-coder:30b", "an older openai: spec matches its listed model");
    assert.equal(deskModelOf(desks, "avalon", 3), "default");
    assert.equal(deskModelOf(undefined, "avalon", 1), "default", "before the desks load");
  });

  it("shows a machine's shared model, or nothing when its desks differ", () => {
    assert.equal(machineModelOf(desks, "avalon", 2), undefined, "mixed");
    assert.equal(machineModelOf(desks, "canfod", 2), "default");
    assert.equal(machineModelOf({ desks: [{ desk: "x#1", model: "claude-haiku-5-5" }, { desk: "x#2", model: "anthropic/claude-haiku-5-5" }] }, "x", 2), "anthropic/claude-haiku-5-5");
  });

  it("lets the browser read the models and desks, and choose a desk's model", () => {
    assert.equal(hubPath("GET", ["models"]), "/api/models");
    assert.equal(hubPath("GET", ["desks"]), "/api/desks");
    assert.equal(hubPath("POST", ["desks"]), "/api/desks");
    assert.equal(hubPath("POST", ["models"]), undefined);
  });
});

describe("model providers in the console", () => {
  const form = { preset: "openai" as const, key: "", url: "", name: "", vision: false };

  it("builds the add request, and says what's missing first", () => {
    assert.deepEqual(providerBody(form), { error: "OpenAI needs an API key" });
    assert.deepEqual(providerBody({ ...form, key: " sk-1 " }), { body: { preset: "openai", key: "sk-1" } });
    assert.deepEqual(providerBody({ ...form, key: "sk-1", url: "http://ignored" }), { body: { preset: "openai", key: "sk-1" } }, "a cloud provider knows its address");
    assert.deepEqual(providerBody({ ...form, preset: "ollama" }), { error: "Give the server's address" });
    assert.deepEqual(providerBody({ ...form, preset: "ollama", url: "http://avalon:11434/v1", name: "ollama-lab", vision: true }), {
      body: { preset: "ollama", id: "ollama-lab", baseUrl: "http://avalon:11434/v1", vision: true },
    });
    assert.ok("error" in providerBody({ ...form, key: "k", name: "My Lab" }), "a name the Hub would refuse");
    assert.deepEqual(providerBody({ ...form, preset: "anthropic", key: "k", vision: true }), { body: { preset: "anthropic", key: "k" } }, "no vision flag for Claude");
    assert.equal(providerId({ preset: "ollama", name: " " }), "ollama", "named after its preset");
    assert.equal(providerId({ preset: "ollama", name: "ollama-lab" }), "ollama-lab");
  });

  it("describes a provider without ever needing its key", () => {
    const added: Provider = { id: "openai", preset: "openai", kind: "openai-compatible", label: "OpenAI", source: "added", hasKey: true, baseUrl: "https://api.openai.com/v1", models: 42 };
    assert.deepEqual(providerDetail(added), { detail: "42 models · key stored", badge: { label: "Working", tone: "good" } });
    const local: Provider = { id: "local", preset: "custom", kind: "openai-compatible", label: "Local", source: "environment", hasKey: false, baseUrl: "http://avalon:11434/v1", error: "fetch failed" };
    assert.deepEqual(providerDetail(local), { detail: "fetch failed · http://avalon:11434/v1 · from the Hub's .env", badge: { label: "Unreachable", tone: "bad" } });
  });

  it("warns before a key crosses the network unencrypted", () => {
    assert.equal(keyTravelsInClear({ protocol: "http:", hostname: "192.168.101.20" }), true);
    assert.equal(keyTravelsInClear({ protocol: "https:", hostname: "agent007.tail1234.ts.net" }), false);
    assert.equal(keyTravelsInClear({ protocol: "http:", hostname: "localhost" }), false, "on the Hub machine itself");
  });

  it("builds a price from the form, with a decimal comma too", () => {
    const none = { cacheRead: "" };
    assert.deepEqual(priceBody({ model: " openai/gpt-5 ", input: "1,25", output: "10", ...none }), { body: { model: "openai/gpt-5", input: 1.25, output: 10 } });
    assert.deepEqual(priceBody({ model: "g", input: "0.75", output: "3.75", cacheRead: "0,075" }), { body: { model: "g", input: 0.75, output: 3.75, cacheRead: 0.075 } });
    assert.ok("error" in priceBody({ model: "", input: "1", output: "1", ...none }));
    assert.ok("error" in priceBody({ model: "m", input: "", output: "1", ...none }), "an empty price isn't $0");
    assert.ok("error" in priceBody({ model: "m", input: "-1", output: "1", ...none }));
    assert.ok("error" in priceBody({ model: "m", input: "1", output: "1", cacheRead: "x" }));
    assert.equal(priceLine({ model: "g", input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75, source: "set" }), "$0.75 in · $3.75 out · $0.075 cached · set here");
    assert.equal(priceLine({ model: "c", input: 1, output: 5, cacheRead: 1, cacheWrite: 1, source: "built-in" }), "$1 in · $5 out");
  });

  it("lets the browser list, add and remove providers and prices, and nothing else of theirs", () => {
    assert.equal(hubPath("GET", ["providers"]), "/api/providers");
    assert.equal(hubPath("POST", ["providers"]), "/api/providers");
    assert.equal(hubPath("POST", ["providers", "ollama-lab", "remove"]), "/api/providers/ollama-lab/remove");
    assert.equal(hubPath("POST", ["providers", "..", "remove"]), undefined);
    assert.equal(hubPath("GET", ["prices"]), "/api/prices");
    assert.equal(hubPath("POST", ["prices"]), "/api/prices");
    assert.equal(hubPath("POST", ["prices", "remove"]), "/api/prices/remove");
    assert.equal(hubPath("GET", ["providers", "openai"]), undefined);
  });
});
