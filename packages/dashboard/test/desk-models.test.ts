import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hubPath } from "../lib/hub-routes.ts";
import type { Desks, Models } from "../lib/types.ts";
import { deskModelChoices, deskModelOf, machineModelOf } from "../lib/view.ts";

const models: Models = {
  architect: "claude-opus-5-5",
  defaultAgent: "claude-haiku-5-5",
  available: [
    { model: "claude-haiku-5-5", spec: "claude-haiku-5-5", provider: "anthropic" },
    { model: "qwen3-coder:30b", spec: "openai:qwen3-coder:30b", provider: "openai-compatible", baseUrl: "http://avalon:11434/v1" },
  ],
};
const desks: Desks = {
  architect: "claude-opus-5-5",
  defaultAgent: "claude-haiku-5-5",
  desks: [
    { desk: "avalon#1", model: "openai:qwen3-coder:30b" },
    { desk: "avalon#2", model: "openai:llama3.3:70b" },
  ],
  models: [],
};

describe("models per desk in the console", () => {
  it("offers the default, Claude, local models, and a model a desk uses that isn't listed", () => {
    assert.deepEqual(deskModelChoices(models, desks), [
      { value: "default", label: "Default (claude-haiku-5-5)" },
      { value: "claude-haiku-5-5", label: "claude-haiku-5-5" },
      { value: "qwen3-coder:30b", label: "qwen3-coder:30b (local)" },
      { value: "openai:llama3.3:70b", label: "openai:llama3.3:70b (not listed)" },
    ]);
  });

  it("shows each desk's choice by the name it's picked by", () => {
    assert.equal(deskModelOf(desks, models, "avalon", 1), "qwen3-coder:30b");
    assert.equal(deskModelOf(desks, models, "avalon", 3), "default");
    assert.equal(deskModelOf(undefined, models, "avalon", 1), "default", "before the desks load");
  });

  it("shows a machine's shared model, or nothing when its desks differ", () => {
    assert.equal(machineModelOf(desks, models, "avalon", 2), undefined, "mixed");
    assert.equal(machineModelOf(desks, models, "canfod", 2), "default");
    assert.equal(machineModelOf({ desks: [{ desk: "x#1", model: "claude-haiku-5-5" }, { desk: "x#2", model: "claude-haiku-5-5" }] }, models, "x", 2), "claude-haiku-5-5");
  });

  it("lets the browser read the models and desks, and choose a desk's model", () => {
    assert.equal(hubPath("GET", ["models"]), "/api/models");
    assert.equal(hubPath("GET", ["desks"]), "/api/desks");
    assert.equal(hubPath("POST", ["desks"]), "/api/desks");
    assert.equal(hubPath("POST", ["models"]), undefined);
  });
});
