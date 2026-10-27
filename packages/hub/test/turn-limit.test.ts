import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessage, type AgentMessage } from "@aso/shared";
import { postTask, reply, ScriptedModel, text, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

function payloadOf<T extends AgentMessage["type"]>(m: AgentMessage, type: T): Extract<AgentMessage, { type: T }>["payload"] {
  assert.equal(m.type, type);
  return (m as Extract<AgentMessage, { type: T }>).payload;
}

const hubOpts = {
  llm: {
    adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")),
    agentAdapter: new ScriptedModel(() => reply([text("still looking around")], "end_turn"), "claude-haiku-5-5"),
    agentModel: "claude-haiku-5-5",
    escalation: false,
    maxTurns: 1,
  },
};

/** Take the assignment, use the one turn allowed, ask for another: refused at the limit. */
async function runOutOfTurns(w: Awaited<ReturnType<typeof worker>>, taskId: string) {
  payloadOf(await w.next(), "TASK_ASSIGNMENT");
  w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId, slot: 1 }));
  const conversationId = crypto.randomUUID();
  const ask = (turn: number) => w.send(createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId, conversationId, turn, toolResults: [] } as never));
  ask(0);
  assert.equal(payloadOf(await w.next(), "PROMPT_RESULT").outcome, "ok");
  ask(1);
  const limit = payloadOf(await w.next(), "PROMPT_RESULT");
  assert.ok(limit.outcome === "error" && /reached the limit of 1 turns/.test(limit.error));
  // The worker saves the work and reports the failure, as it does.
  w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId, detail: "conversation reached the limit of 1 turns (unfinished work saved on task/x)" }));
}

describe("an agent that runs out of turns", () => {
  it("gets a rework round that continues from its saved work, instead of failing the task", async () => {
    await withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev");
      await postTask(ctx.port, { taskId: "big", role: "backend", title: "Big", description: "d" });
      await runOutOfTurns(w, "big");

      const again = payloadOf(await w.next(), "TASK_ASSIGNMENT");
      assert.equal(again.rework?.round, 1);
      assert.match(again.rework!.reason, /used all its turns before finishing\. Its work so far is on this branch: continue from it/);
      const task = ctx.hub.tasks.get("big")!;
      assert.equal(task.reworkRound, 1, "it counts toward the rework limit, so escalation applies");
      assert.ok(task.history.some((h) => /the agent used all 1 turns before finishing; its work so far is kept/.test(h.event)));
      w.ws.close();
    }, hubOpts);
  });

  it("fails the task once the rework rounds are used up", async () => {
    await withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev");
      await postTask(ctx.port, { taskId: "big", role: "backend", title: "Big", description: "d" });
      await waitFor(() => ctx.hub.tasks.get("big")?.state === "assigned");
      ctx.hub.tasks.get("big")!.reworkRound = 3; // the rounds are used up
      await runOutOfTurns(w, "big");
      await waitFor(() => ctx.hub.tasks.get("big")?.state === "failed");
      assert.match(ctx.hub.tasks.get("big")!.detail ?? ctx.hub.tasks.get("big")!.history.at(-1)!.event, /gave up after 3 rework rounds/);
      w.ws.close();
    }, hubOpts);
  });
});
