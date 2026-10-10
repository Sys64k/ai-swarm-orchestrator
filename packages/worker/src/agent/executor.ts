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
      requestDependency: (req) => ctx.requestDependency(req),
      fileOperation: (op) => ctx.fileOperation(op),
    });
    const conversationId = randomUUID();
    let turn = 0;
    let results: ToolResult[] = [];

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
        if (parsed.success && results.every((r) => !r.isError)) {
          log.info(`task ${task.taskId} finished: ${parsed.data.summary.split("\n")[0]}`);
          ctx.report(`finished: ${parsed.data.summary.slice(0, 500)}`);
          return { commitMessage: parsed.data.commit_message, summary: parsed.data.summary };
        }
        // Refuse a premature finish: the model sees why and continues.
        results.push({
          toolUseId: finish.id,
          content: parsed.success
            ? "finish was not accepted because other tool calls in the same turn failed; fix them first"
            : `invalid finish input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          isError: true,
        });
      } else if (reply.toolCalls.length === 0) {
        // Ended its turn without finish: treat the final message as the summary.
        log.info(`task ${task.taskId}: model ended without finish; committing its work`);
        return { commitMessage: `${task.taskId}: ${task.title}`, summary: reply.text || undefined };
      }
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
