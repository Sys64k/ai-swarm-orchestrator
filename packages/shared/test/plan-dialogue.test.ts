import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countReplies, lastReplyAsksForChanges, MAX_PLAN_REPLIES, replyMode, type PlanDialogueEntry } from "@aso/shared";

const reply = (text: string): PlanDialogueEntry => ({ kind: "reply", at: "", text });
const questions: PlanDialogueEntry = { kind: "questions", at: "", questions: ["Why?"] };
const proposal: PlanDialogueEntry = { kind: "proposal", at: "", summary: "s", tasks: [] };

describe("plan dialogue rules", () => {
  it("counts replies (the planning round)", () => {
    assert.equal(countReplies(undefined), 0);
    assert.equal(countReplies([questions, reply("a"), proposal, reply("b")]), 2);
  });

  it("allows answering questions and asking for changes, up to the limit", () => {
    assert.equal(replyMode("awaiting_input", []), "answer");
    assert.equal(replyMode("proposed", undefined), "changes");
    assert.equal(replyMode("planning", []), undefined);
    const full = Array.from({ length: MAX_PLAN_REPLIES }, (_, i) => reply(`r${i}`));
    assert.equal(replyMode("proposed", full), undefined);
  });

  it("tells a change request from an answer", () => {
    assert.equal(lastReplyAsksForChanges([questions, reply("a")]), false);
    assert.equal(lastReplyAsksForChanges([questions, reply("a"), proposal, reply("b")]), true);
    assert.equal(lastReplyAsksForChanges([proposal]), false);
  });
});
