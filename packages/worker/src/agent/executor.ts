import { randomUUID } from "node:crypto";
import { AGENT_TOOLS, createLogger, TURN_IMAGE_BUDGET, type ScreenshotTarget } from "@aso/shared";
import type { ExecutionContext, TaskAssignment, TaskExecutor } from "../jobs.js";
import type { ModelReply, ModelTurn } from "../model-channel.js";
import { AgentTools, type ToolResult } from "./tools.js";

const log = createLogger("agent");

/** Backoff for retryable model errors (rate limits, API outages). */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** How often to ask again while the Hub holds model calls (e.g. out of credit). */
export const PAUSE_RETRY_MS = 60_000;
/** Empty replies in a row (no text, no tool call) the agent is asked again after, before the task fails. */
export const MAX_EMPTY_REPLIES = 3;
/** Keep each turn's text results well under the Hub's frame limit (images have TURN_IMAGE_BUDGET). */
const TURN_RESULTS_BUDGET = 1_200_000;

export class ModelError extends Error {
  override name = "ModelError";
}

/** The agent stopped twice without calling `finish`; its work is not handed in. */
export class AgentStoppedError extends Error {
  override name = "AgentStoppedError";
}

/** A tests-first task's builder disputed a test written first (`dispute_tests`); its work is kept, not handed in. */
export class TestsDisputedError extends Error {
  override name = "TestsDisputedError";
}

/**
 * The coding agent. Runs on the worker: asks the Hub for the model's next step, executes the
 * requested tools in the checkout, sends the results back, until the model calls `finish`.
 */
export class LlmTaskExecutor implements TaskExecutor {
  constructor(private readonly opts: { retryDelaysMs?: number[] } = {}) {}

  async implement(
    task: TaskAssignment,
    ctx: ExecutionContext,
  ): Promise<{ commitMessage: string; summary?: string; screenshotTargets?: ScreenshotTarget[] }> {
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
    // An empty reply isn't a stop: giving up comes with an explanation (CONTINUE_PROMPT). Reasoning models send them.
    let emptyReplies = 0;

    for (;;) {
      const reply = await callModelWithRetry((t) => ctx.callModel(t), { conversationId, turn, toolResults: results }, (m) => ctx.report(m), this.opts.retryDelaysMs);
      turn = reply.turn + 1;
      const calls = reply.toolCalls.filter((c) => c.name !== "finish");
      const finish = reply.toolCalls.find((c) => c.name === "finish");
      // A dispute ends the attempt at once; the call is refused like any unknown tool on a task without tests written first.
      const dispute = reply.toolCalls.find((c) => c.name === "dispute_tests");
      if (dispute && task.testsFirst) {
        const parsed = AGENT_TOOLS.dispute_tests.input.safeParse(dispute.input);
        if (parsed.success) throw new TestsDisputedError(`the builder disputes a test written first: ${parsed.data.test}: ${parsed.data.reason}`);
      }
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
          const screenshotTargets = parsed.data.screenshots?.length ? parsed.data.screenshots : undefined;
          return { commitMessage: parsed.data.commit_message, summary: parsed.data.summary, screenshotTargets };
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
        if (!reply.text.trim() && emptyReplies < MAX_EMPTY_REPLIES) {
          emptyReplies++;
          log.info(`task ${task.taskId}: model replied with nothing; asking again (${emptyReplies} of ${MAX_EMPTY_REPLIES})`);
          ctx.report("agent replied with nothing; asking it again");
          continue;
        }
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
      emptyReplies = 0;
      results = fitTurnResults(results);
    }
  }
}

/**
 * Calls the model, retrying retryable failures with backoff; throws ModelError otherwise. While
 * the Hub holds model calls (`paused`, e.g. out of credit) it waits as long as that lasts,
 * asking again every `pauseMs`, without using up its retries.
 */
export async function callModelWithRetry(
  call: (turn: ModelTurn) => Promise<ModelReply>,
  turn: ModelTurn,
  report: (msg: string) => void,
  delays: number[] = RETRY_DELAYS_MS,
  pauseMs = PAUSE_RETRY_MS,
): Promise<Extract<ModelReply, { outcome: "ok" }>> {
  let waiting = false;
  for (let attempt = 0; ; attempt++) {
    const reply = await call(turn);
    if (reply.outcome === "ok") return reply;
    if (reply.paused) {
      if (!waiting) report(`waiting: ${reply.error}`);
      waiting = true;
      attempt--;
      await new Promise((r) => setTimeout(r, pauseMs));
      continue;
    }
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

/**
 * Fit a turn's tool results into one frame: the text budget is shared across results so one
 * huge output can't crowd out the rest, and images go in order until TURN_IMAGE_BUDGET is used;
 * a later image is left out, and its result says so.
 */
export function fitTurnResults(results: ToolResult[]): ToolResult[] {
  const per = Math.floor(TURN_RESULTS_BUDGET / Math.max(1, results.length));
  let imageChars = 0;
  return results.map((r) => {
    const fitted = r.content.length <= per ? r : { ...r, content: `${r.content.slice(0, per)}\n… truncated to fit this turn` };
    if (!r.image) return fitted;
    if (imageChars + r.image.data.length <= TURN_IMAGE_BUDGET) {
      imageChars += r.image.data.length;
      return fitted;
    }
    const { image: _, ...text } = fitted;
    const mb = (TURN_IMAGE_BUDGET * 0.75) / 1_000_000;
    return { ...text, isError: true, content: `${text.content}\nImage not sent: this turn's images are over ${mb.toFixed(1)} MB together. View it again in a later turn.` };
  });
}
