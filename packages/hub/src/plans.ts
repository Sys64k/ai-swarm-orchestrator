import { randomBytes } from "node:crypto";
import {
  countReplies,
  createLogger,
  MAX_PLAN_REPLIES,
  MAX_PLAN_REPLY_LENGTH,
  orderPlan,
  replyMode,
  type PlanDialogueEntry,
  type LlmUsage,
  type MessageOf,
  type PlannedTask,
} from "@aso/shared";
import type { NodeRegistry } from "./registry.js";
import type { AgentTurn, TaskManager } from "./tasks.js";
import type { TranscriptInput } from "./transcripts.js";

const log = createLogger("plans");

/**
 * pending → planning → proposed → approved (tasks created)
 *                   ↘          ↘ rejected
 *                    awaiting_input (the Architect asked questions)
 * A reply to questions or to a proposal (asking for changes) → pending: the Architect plans
 * again with the whole conversation.
 * planning → failed (Architect error) · planning → pending (Architect lost)
 */
export type PlanState = "pending" | "planning" | "awaiting_input" | "proposed" | "approved" | "rejected" | "failed";

/** 0 for the first planning run, then one more per reply. */
export function planRound(plan: Pick<PlanRecord, "dialogue">): number {
  return countReplies(plan.dialogue);
}

export interface PlanRecord {
  planId: string;
  /** The project the plan is for. */
  project: string;
  requirement: string;
  state: PlanState;
  architectNodeId?: string;
  summary?: string;
  tasks?: PlannedTask[];
  /** Plan key → created task id, once approved. */
  taskIds?: Record<string, string>;
  /** Open questions while `awaiting_input`. */
  questions?: string[];
  dialogue?: PlanDialogueEntry[];
  /** Spend before the latest reply; each planning round gets the full plan budget. */
  budgetBaseUsd?: number;
  error?: string;
  llm: { calls: number } & LlmUsage;
  agentLog: AgentTurn[];
  history: Array<{ at: string; event: string }>;
  createdAt: string;
  updatedAt: string;
}

export class PlanError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "invalid",
  ) {
    super(message);
  }
}

/** Architect planning runs: requirement in, approved plan → tasks out. */
export class PlanManager {
  private readonly plans = new Map<string, PlanRecord>();

  constructor(
    private readonly registry: NodeRegistry,
    private readonly tasks: TaskManager,
    /** Called whenever a plan record changes (used to persist Hub state). */
    private readonly onChange?: () => void,
    /** Receives plan events for the plan's transcript. */
    private readonly onTranscript?: (planId: string, entry: TranscriptInput) => void,
    /** Called when an Architect may have become free; with several projects, dispatches all of them. */
    private readonly onDispatchNeeded?: () => void,
  ) {}

  get project(): string {
    return this.tasks.project;
  }

  private kick(): void {
    if (this.onDispatchNeeded) this.onDispatchNeeded();
    else this.dispatch();
  }

  /** Load plans saved before a Hub restart; a plan the Architect was working on is planned again. */
  restore(records: readonly PlanRecord[]): void {
    for (const plan of records) {
      plan.project ??= this.project; // saved before projects existed
      this.plans.set(plan.planId, plan);
      if (plan.state === "planning") {
        plan.state = "pending";
        plan.architectNodeId = undefined;
        this.note(plan, "requeued: Hub restarted during planning");
      }
    }
    if (records.length) log.info(`restored ${records.length} plan(s)`);
  }

  list(): PlanRecord[] {
    return [...this.plans.values()];
  }

  get(planId: string): PlanRecord | undefined {
    return this.plans.get(planId);
  }

  create(requirement: unknown): PlanRecord {
    if (typeof requirement !== "string" || !requirement.trim()) throw new PlanError("requirement must be a non-empty string", "invalid");
    if (requirement.length > 50_000) throw new PlanError("requirement is too long (max 50000 characters)", "invalid");
    const now = new Date().toISOString();
    const plan: PlanRecord = {
      planId: `plan-${randomBytes(4).toString("hex")}`,
      project: this.project,
      requirement: requirement.trim(),
      state: "pending",
      llm: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      agentLog: [],
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this.plans.set(plan.planId, plan);
    this.note(plan, "created");
    this.kick();
    return plan;
  }

  /** Give pending plans to idle Architects. */
  dispatch(): void {
    for (const plan of this.plans.values()) {
      if (plan.state !== "pending") continue;
      const architect = this.registry
        .list()
        .find((n) => n.nodeKind === "architect" && n.currentTaskId === null);
      if (!architect) return;
      this.registry.assign(architect.nodeId, plan.planId);
      plan.state = "planning";
      plan.architectNodeId = architect.nodeId;
      this.note(plan, `planning on ${architect.nodeId}`);
      this.registry.send(architect.nodeId, "PLAN_REQUEST", { planId: plan.planId, project: this.project, requirement: plan.requirement, round: planRound(plan) });
    }
  }

  isPlanning(nodeId: string, planId: string): boolean {
    const plan = this.plans.get(planId);
    return !!plan && plan.state === "planning" && plan.architectNodeId === nodeId;
  }

  /** Returns a protocol error string if the sender isn't planning this plan. */
  handleResult(nodeId: string, result: MessageOf<"PLAN_RESULT">["payload"]): string | undefined {
    if (!this.isPlanning(nodeId, result.planId)) return `plan ${result.planId} is not being planned by ${nodeId}`;
    const plan = this.plans.get(result.planId)!;
    this.registry.release(nodeId, plan.planId);

    if (result.outcome === "failed") {
      plan.state = "failed";
      plan.error = result.error;
      this.note(plan, `failed: ${result.error}`);
    } else if (result.outcome === "questions") {
      plan.state = "awaiting_input";
      plan.questions = result.questions;
      (plan.dialogue ??= []).push({ kind: "questions", at: new Date().toISOString(), questions: result.questions, context: result.context });
      this.note(plan, `the Architect asked ${result.questions.length} question(s); waiting for your answer`);
    } else {
      const ordered = orderPlan(result.tasks);
      if (typeof ordered === "string") {
        plan.state = "failed";
        plan.error = `invalid plan: ${ordered}`;
        this.note(plan, plan.error);
      } else {
        plan.state = "proposed";
        plan.summary = result.summary;
        plan.tasks = ordered;
        this.note(plan, `proposed ${ordered.length} task(s); waiting for approval`);
      }
    }
    this.kick();
    return undefined;
  }

  /** Create the plan's tasks (dependencies first) and start dispatching them. */
  approve(planId: string): PlanRecord {
    const plan = this.require(planId);
    if (plan.state !== "proposed") throw new PlanError(`plan ${planId} is ${plan.state}, not proposed`, "conflict");
    const ids: Record<string, string> = {};
    for (const t of plan.tasks!) {
      const record = this.tasks.submit(
        {
          role: t.role,
          kind: t.kind,
          title: t.title,
          description: t.description,
          acceptanceCriteria: t.acceptanceCriteria,
          files: t.files,
          dependsOn: t.dependsOn.map((k) => ids[k]),
        },
        // The plan key ("api", "login-page") reads far better in ids than a truncated title.
        { planId, idHint: t.key },
      );
      ids[t.key] = record.spec.taskId;
    }
    plan.taskIds = ids;
    plan.state = "approved";
    this.note(plan, `approved; created ${Object.values(ids).join(", ")}`);
    return plan;
  }

  /**
   * The person answers the Architect's questions, or asks for changes to a proposed plan. The
   * plan is planned again, with the whole conversation in the Architect's prompt.
   */
  reply(planId: string, message: unknown): PlanRecord {
    const plan = this.require(planId);
    if (plan.state !== "awaiting_input" && plan.state !== "proposed") {
      throw new PlanError(`plan ${planId} is ${plan.state}; you can reply while it has questions or a proposal`, "conflict");
    }
    if (!replyMode(plan.state, plan.dialogue)) {
      throw new PlanError(`plan ${planId} already has ${MAX_PLAN_REPLIES} replies; approve it, or reject it and start a new plan`, "conflict");
    }
    if (typeof message !== "string" || !message.trim()) throw new PlanError("message must be a non-empty string", "invalid");
    if (message.length > MAX_PLAN_REPLY_LENGTH) throw new PlanError(`message is too long (max ${MAX_PLAN_REPLY_LENGTH} characters)`, "invalid");
    const dialogue = (plan.dialogue ??= []);
    const at = new Date().toISOString();
    if (plan.state === "proposed") {
      dialogue.push({ kind: "proposal", at: plan.updatedAt, summary: plan.summary!, tasks: plan.tasks! });
      plan.summary = undefined;
      plan.tasks = undefined;
    }
    dialogue.push({ kind: "reply", at, text: message.trim() });
    const answered = plan.state === "awaiting_input";
    plan.questions = undefined;
    plan.state = "pending";
    plan.budgetBaseUsd = plan.llm.costUsd;
    this.note(plan, answered ? "you answered; planning again" : "you asked for changes; planning again");
    this.kick();
    return plan;
  }

  /** Spend in the current planning round (the budget applies per round). */
  spentSinceReply(planId: string): number {
    const plan = this.plans.get(planId);
    return plan ? plan.llm.costUsd - (plan.budgetBaseUsd ?? 0) : 0;
  }

  reject(planId: string): PlanRecord {
    const plan = this.require(planId);
    if (plan.state !== "proposed" && plan.state !== "pending" && plan.state !== "awaiting_input") {
      throw new PlanError(`plan ${planId} is ${plan.state}; only pending, questioning or proposed plans can be rejected`, "conflict");
    }
    plan.state = "rejected";
    this.note(plan, "rejected");
    return plan;
  }

  /** An Architect disconnected: its plan goes back to the queue. */
  handleNodeGone(nodeId: string): void {
    for (const plan of this.plans.values()) {
      if (plan.state === "planning" && plan.architectNodeId === nodeId) {
        plan.state = "pending";
        plan.architectNodeId = undefined;
        this.note(plan, `requeued: ${nodeId} disconnected`);
      }
    }
    this.kick();
  }

  recordLlmUsage(planId: string, usage: LlmUsage): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    const l = plan.llm;
    l.calls++;
    l.inputTokens += usage.inputTokens;
    l.outputTokens += usage.outputTokens;
    l.cacheReadTokens += usage.cacheReadTokens;
    l.cacheWriteTokens += usage.cacheWriteTokens;
    l.costUsd = Math.round((l.costUsd + usage.costUsd) * 1e6) / 1e6;
    this.onChange?.();
  }

  recordAgentTurn(planId: string, turn: Omit<AgentTurn, "at">): void {
    this.plans.get(planId)?.agentLog.push({ at: new Date().toISOString(), ...turn });
    this.onChange?.();
  }

  recordEvent(planId: string, event: string): void {
    const plan = this.plans.get(planId);
    if (plan) this.note(plan, event);
  }

  private require(planId: string): PlanRecord {
    const plan = this.plans.get(planId);
    if (!plan) throw new PlanError(`plan ${planId} not found`, "not_found");
    return plan;
  }

  private note(plan: PlanRecord, event: string): void {
    const at = new Date().toISOString();
    plan.updatedAt = at;
    plan.history.push({ at, event });
    log.info(`${plan.planId}: ${event}`);
    this.onTranscript?.(plan.planId, { kind: "event", text: event });
    this.onChange?.();
  }
}
