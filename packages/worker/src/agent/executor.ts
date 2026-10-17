import { randomUUID } from "node:crypto";
import { AGENT_TOOLS, createLogger } from "@aso/shared";
import type { ExecutionContext, TaskAssignment, TaskExecutor } from "../jobs.js";
import type { ModelReply, ModelTurn } from "../model-channel.js";
import { AgentTools, type ToolResult } from "./tools.js";

const log = createLogger("agent");

/** Backoff for retryable model errors (rate limits, API outages). */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Keep each turn's tool results well under the Hub's 2 MB frame limit. */
const TURN_RESULTS_BUDGET = 1_200_000;

export class ModelError extends Error {
  override name = "ModelError";
}

/** The agent stopped twice without calling `finish`; its work is not handed in. */
export class AgentStoppedError extends Error {
  override name = "AgentStoppedError";
}

/**
 * The coding agent. Runs on the worker: asks the Hub for the model's next step, executes the
 * requested tools in the checkout, sends the results back, until the model calls `finish`.
 */
export class LlmTaskExecutor implements TaskExecutor {
  constructor(private readonly opts: { retryDelaysMs?: number[] } = {}) {}

  async implement(task: TaskAssignment, ctx: ExecutionContext): Promise<{ commitMessage: string; summary?: string }> {
    const tools = new AgentTools({
      repoDir: ctx.repoDir,
      role: task.role,
      requestDependencies: (packages) => ctx.requestDependencies(packages),
      setPackageScripts: (scripts) => ctx.setPackageScripts(scripts),
      fileOperation: (op) => ctx.fileOperation(op),
      commands: ctx.commands,
    });
    const conversationId = randomUUID();
    let turn = 0;
    let results: ToolResult[] = [];
    // Set after the model ended a turn without finish; a second stop in a row fails the task.
    let reminded = false;

    for (;;) {
      const reply = await callModelWithRetry((t) => ctx.callModel(t), { conversationId, turn, toolResults: results }, (m) => ctx.report(m), this.opts.retryDelaysMs);
      turn = reply.turn + 1;
      const calls = reply.toolCalls.filter((c) => c.name !== "finish");
      const finish = reply.toolCalls.find((c) => c.name === "finish");
      ctx.report(
        `turn ${reply.turn}: ${[...calls.map((c) => describe(c)), ...(finish ? ["finish"] : [])].join(", ") || reply.stopReason}`,
      );

      results = [];
      for (const call of calls) results.push(await tools.execute(call));

      if (finish) {
        const parsed = AGENT_TOOLS.finish.input.safeParse(finish.input);
        const refused = parsed.success && results.every((r) => !r.isError) ? await ctx.checkFinish?.() : undefined;
        if (parsed.success && results.every((r) => !r.isError) && !refused) {
          log.info(`task ${task.taskId} finished: ${parsed.data.summary.split("\n")[0]}`);
          ctx.report(`finished: ${parsed.data.summary.slice(0, 500)}`);
          return { commitMessage: parsed.data.commit_message, summary: parsed.data.summary };
        }
        // Refuse a premature finish: the model sees why and continues.
        results.push({
          toolUseId: finish.id,
          content: refused
            ? `finish was not accepted: ${refused}`
            : parsed.success
              ? "finish was not accepted because other tool calls in the same turn failed; fix them first"
              : `invalid finish input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          isError: true,
        });
      } else if (reply.toolCalls.length === 0) {
        // Never hand in work the agent did not finish: remind it once, then give up.
        if (reminded) {
          throw new AgentStoppedError(`the agent stopped without calling finish: ${reply.text.slice(0, 1500) || "(no explanation)"}`);
        }
        log.info(`task ${task.taskId}: model ended without finish; reminding it once`);
        ctx.report("agent stopped without finish; reminding it");
        reminded = true;
        continue;
      }
      reminded = false;
      results = fitBudget(results);
    }
  }
}

/** Calls the model, retrying retryable failures with backoff; throws ModelError otherwise. */
export async function callModelWithRetry(
  call: (turn: ModelTurn) => Promise<ModelReply>,
  turn: ModelTurn,
  report: (msg: string) => void,
  delays: number[] = RETRY_DELAYS_MS,
): Promise<Extract<ModelReply, { outcome: "ok" }>> {
  for (let attempt = 0; ; attempt++) {
    const reply = await call(turn);
    if (reply.outcome === "ok") return reply;
    if (!reply.retryable || attempt >= delays.length) throw new ModelError(reply.error);
    log.warn(`model call failed (${reply.error}); retrying in ${delays[attempt] / 1000}s`);
    report(`model unavailable, retrying: ${reply.error}`);
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }
}

export function describe(call: { name: string; input: Record<string, unknown> }): string {
  const arg = call.input.path ?? (Array.isArray(call.input.argv) ? (call.input.argv as string[]).join(" ") : call.input.name ?? call.input.pattern);
  return typeof arg === "string" ? `${call.name} ${arg.slice(0, 80)}` : call.name;
}

/** Share the per-turn budget across results so one huge output can't crowd out the rest. */
function fitBudget(results: ToolResult[]): ToolResult[] {
  const per = Math.floor(TURN_RESULTS_BUDGET / Math.max(1, results.length));
  return results.map((r) =>
    r.content.length <= per ? r : { ...r, content: `${r.content.slice(0, per)}\n… truncated to fit this turn` },
  );
}
