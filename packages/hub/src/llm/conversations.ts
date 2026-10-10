import type Anthropic from "@anthropic-ai/sdk";
import {
  agentToolDefinitions,
  createLogger,
  type MessageOf,
  type PayloadInput,
  type WorkerRole,
} from "@aso/shared";
import type { NodeRegistry } from "../registry.js";
import type { TaskManager } from "../tasks.js";
import { LlmError, type LlmAdapter } from "./adapter.js";
import { priceUsage } from "./pricing.js";
import { systemPrompt, taskPrompt } from "./prompts.js";

const log = createLogger("llm");

type Request = MessageOf<"PROMPT_EXECUTION">["payload"];
type Result = PayloadInput<"PROMPT_RESULT">;
type OkResult = Extract<Result, { outcome: "ok" }>;

export interface ConversationOptions {
  /** Per-task spend cap (USD, estimated). */
  taskBudgetUsd?: number;
  /** Model turns per conversation. */
  maxTurns?: number;
  /** Concurrent API requests across all workers. */
  concurrency?: number;
  /** Drop idle conversations after this long. */
  idleTimeoutMs?: number;
}

interface Conversation {
  id: string;
  taskId: string;
  nodeId: string;
  role: WorkerRole;
  system: string;
  /** Append-only: thinking blocks are only valid in the exact conversation that produced them. */
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Next expected turn. */
  turn: number;
  /** tool_use ids the next turn must answer. */
  pendingToolUseIds: string[];
  results: Map<number, OkResult>;
  inflight?: string;
  lastActivity: number;
}

/**
 * Hub side of the agent loop. Workers send tool results; the Hub owns the conversation,
 * composes the prompts, calls the model and returns only the visible text and tool calls.
 */
export class ConversationManager {
  private readonly conversations = new Map<string, Conversation>();
  /** requestId → conversation, for answering retries. */
  private readonly requests = new Map<string, { conversationId: string; turn: number }>();
  private readonly tools: Anthropic.Beta.BetaTool[];
  private readonly taskBudgetUsd: number;
  private readonly maxTurns: number;
  private readonly idleTimeoutMs: number;
  private readonly slots: Semaphore;
  private totals = { calls: 0, costUsd: 0 };

  constructor(
    private readonly adapter: LlmAdapter | undefined,
    private readonly tasks: TaskManager,
    private readonly registry: NodeRegistry,
    opts: ConversationOptions = {},
  ) {
    this.taskBudgetUsd = opts.taskBudgetUsd ?? 5;
    this.maxTurns = opts.maxTurns ?? 80;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
    this.slots = new Semaphore(opts.concurrency ?? 2);
    // Byte-stable and in a fixed order, so tools + system prompt form a cacheable prefix.
    this.tools = agentToolDefinitions().map(
      (t) => ({ ...t, eager_input_streaming: true }) as unknown as Anthropic.Beta.BetaTool,
    );
  }

  status() {
    return {
      configured: this.adapter !== undefined,
      adapter: this.adapter?.name ?? null,
      model: this.adapter?.model ?? null,
      taskBudgetUsd: this.taskBudgetUsd,
      maxTurns: this.maxTurns,
      queue: this.slots.status(),
      conversations: this.conversations.size,
      totals: { calls: this.totals.calls, costUsd: round(this.totals.costUsd) },
    };
  }

  /** Returns a protocol error string, or undefined if the request was taken for processing. */
  handle(nodeId: string, req: Request): string | undefined {
    const seen = this.requests.get(req.requestId);
    if (seen) {
      const conv = this.conversations.get(seen.conversationId);
      if (conv && conv.nodeId !== nodeId) return `request ${req.requestId} belongs to another node`;
      const cached = conv?.results.get(seen.turn);
      if (cached) this.respond(nodeId, cached);
      return undefined; // still in flight: the answer will arrive
    }

    const fail = (error: string, retryable = false) =>
      this.respond(nodeId, { requestId: req.requestId, outcome: "error", error, retryable });

    if (!this.adapter) return void fail("no LLM configured on the Hub (set ANTHROPIC_API_KEY and restart it)");
    if (!this.tasks.isImplementing(nodeId, req.taskId)) {
      return void fail(`task ${req.taskId} is not being implemented by ${nodeId}`);
    }

    let conv = this.conversations.get(req.conversationId);
    if (!conv) {
      if (req.turn !== 0) return void fail(`unknown conversation ${req.conversationId}`);
      const task = this.tasks.get(req.taskId)!;
      conv = {
        id: req.conversationId,
        taskId: req.taskId,
        nodeId,
        role: task.spec.role,
        system: systemPrompt(task.spec.role),
        messages: [],
        turn: 0,
        pendingToolUseIds: [],
        results: new Map(),
        lastActivity: Date.now(),
      };
      this.conversations.set(conv.id, conv);
      this.tasks.recordEvent(req.taskId, `agent conversation started on ${nodeId}`);
    } else if (conv.nodeId !== nodeId || conv.taskId !== req.taskId) {
      return void fail(`conversation ${req.conversationId} belongs to another task or node`);
    }

    if (req.turn < conv.turn) {
      // Retry of an answered turn under a new requestId.
      const cached = conv.results.get(req.turn);
      if (cached) this.respond(nodeId, { ...cached, requestId: req.requestId });
      else fail(`turn ${req.turn} is no longer available`);
      return undefined;
    }
    if (req.turn > conv.turn) return void fail(`expected turn ${conv.turn}, got ${req.turn}`);
    if (conv.inflight) return void fail(`turn ${req.turn} is already being processed`, true);
    if (req.turn >= this.maxTurns) return void fail(`conversation reached the limit of ${this.maxTurns} turns`);

    const expected = [...conv.pendingToolUseIds].sort().join(",");
    const got = req.toolResults.map((r) => r.toolUseId).sort().join(",");
    if (expected !== got) return void fail(`tool results must answer exactly the pending tool calls [${expected}], got [${got}]`);

    const spent = this.tasks.get(req.taskId)?.llm.costUsd ?? 0;
    if (spent >= this.taskBudgetUsd) {
      return void fail(`task ${req.taskId} reached its LLM budget ($${spent.toFixed(2)} of $${this.taskBudgetUsd})`);
    }

    const userMessage: Anthropic.Beta.BetaMessageParam =
      req.turn === 0
        ? { role: "user", content: taskPrompt(this.tasks.get(req.taskId)!) }
        : {
            role: "user",
            content: req.toolResults.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.toolUseId,
              content: r.content,
              is_error: r.isError,
            })),
          };

    conv.inflight = req.requestId;
    conv.lastActivity = Date.now();
    this.requests.set(req.requestId, { conversationId: conv.id, turn: req.turn });
    void this.run(conv, req, userMessage);
    return undefined;
  }

  private async run(conv: Conversation, req: Request, userMessage: Anthropic.Beta.BetaMessageParam): Promise<void> {
    const fail = (error: string, retryable: boolean) => {
      // Not committed: the worker may retry this turn with a new requestId.
      this.requests.delete(req.requestId);
      this.respond(conv.nodeId, { requestId: req.requestId, outcome: "error", error, retryable });
    };
    try {
      const messages = [...conv.messages, userMessage];
      const response = await this.slots.run(() =>
        this.adapter!.complete({ system: conv.system, tools: this.tools, messages }),
      );

      const usage = priceUsage(response.model, response.tokens);
      this.totals.calls++;
      this.totals.costUsd += usage.costUsd;
      this.tasks.recordLlmUsage(conv.taskId, usage);

      if (response.stopReason === "refusal") {
        return fail(`the model declined this request${response.refusalCategory ? ` (${response.refusalCategory})` : ""}`, false);
      }
      if (response.stopReason === "max_tokens") {
        return fail("the model's response exceeded the per-turn output limit", true);
      }

      const toolCalls = response.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      conv.messages = [...messages, { role: "assistant", content: response.content }];
      conv.pendingToolUseIds = toolCalls.map((c) => c.id);
      const result: OkResult = {
        requestId: req.requestId,
        outcome: "ok",
        conversationId: conv.id,
        turn: conv.turn,
        text,
        toolCalls,
        stopReason: response.stopReason ?? "unknown",
        usage,
      };
      conv.results.set(conv.turn, result);
      conv.turn++;
      log.debug(
        `${conv.taskId} turn ${result.turn}: ${toolCalls.map((c) => c.name).join(", ") || response.stopReason} ($${usage.costUsd.toFixed(4)})`,
      );
      this.respond(conv.nodeId, result);
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError((err as Error).message, false);
      log.warn(`${conv.taskId} turn ${req.turn} failed: ${e.message}`);
      if (!e.retryable) this.tasks.recordEvent(conv.taskId, `LLM error: ${e.message}`);
      fail(e.message, e.retryable);
    } finally {
      conv.inflight = undefined;
      conv.lastActivity = Date.now();
    }
  }

  /** Forget conversations that are idle or whose task moved on. */
  sweep(now = Date.now()): void {
    for (const conv of this.conversations.values()) {
      if (conv.inflight) continue;
      if (now - conv.lastActivity > this.idleTimeoutMs || !this.tasks.isImplementing(conv.nodeId, conv.taskId)) {
        this.conversations.delete(conv.id);
        for (const [id, r] of this.requests) if (r.conversationId === conv.id) this.requests.delete(id);
      }
    }
  }

  private respond(nodeId: string, result: Result): void {
    if (this.registry.has(nodeId)) this.registry.send(nodeId, "PROMPT_RESULT", result);
  }
}

/** Limits concurrent API calls; excess requests wait in FIFO order. */
class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  status() {
    return { running: this.running, waiting: this.waiting.length, limit: this.limit };
  }
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
