import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { architectSystemPrompt, systemPrompt } from "@aso/hub";
import { describeWritable } from "@aso/shared";

describe("the Architect's instructions", () => {
  it("say what each role may change, from the rules the worker and Hub enforce", () => {
    const prompt = architectSystemPrompt();
    for (const role of ["backend", "frontend", "qa", "devops"] as const) {
      assert.ok(prompt.includes(`  - ${role}: ${describeWritable(role)}\n`), role);
    }
    assert.match(prompt, /Give every task a role that may change all the files it must change/);
    assert.match(prompt, /split into a backend\/frontend task it depends on/);
  });

  it("keep existing tests in the task that changes the behaviour they check", () => {
    const prompt = architectSystemPrompt();
    assert.match(prompt, /updates, in the same task, the existing tests that check the old behaviour/);
    assert.match(prompt, /never leave those updates to a later qa task/);
  });

  it("stay byte-stable, so they stay in the prompt cache", () => {
    assert.equal(architectSystemPrompt(), architectSystemPrompt());
  });
});

describe("an implementing agent's instructions", () => {
  it("ask it to update the existing tests, end-to-end specs included, that its change breaks", () => {
    assert.match(systemPrompt("frontend"), /update those tests in this task, end-to-end specs included/);
  });
});
