import { randomBytes } from "node:crypto";
import {
  TaskSpecInputSchema,
  TaskSpecSchema,
  createLogger,
  type MessageOf,
  type PayloadInput,
  type TaskKind,
  type LlmUsage,
  type TaskSpec,
} from "@aso/shared";
import type { HubRepository } from "./git/hub-repo.js";
import type { NodeRegistry } from "./registry.js";
import { DEFAULT_ROUTING_POLICIES, selectNode, type RoutingPolicies } from "./routing.js";
import type { TranscriptInput } from "./transcripts.js";

const log = createLogger("tasks");

/**
 * pending → assigned → in_progress → verifying → awaiting_qa → testing → merging → merged
 * Verification, QA or merge problems send the task back to pending as a rework round.
 * A person can cancel any task that isn't finished, and retry a failed or cancelled one.
 */
export type TaskState =
  | "pending"
  | "assigned"
  | "in_progress"
  | "verifying"
  | "awaiting_qa"
  | "testing"
  | "merging"
  | "merged"
  | "failed"
  | "cancelled";

type Rework = NonNullable<PayloadInput<"TASK_ASSIGNMENT">["rework"]>;
type Feedback = MessageOf<"FEEDBACK_LOOP">["payload"];

export interface TaskRecord {
  spec: TaskSpec;
  /** The project (folder in the Hub's projects root) the task works on. */
  project: string;
  state: TaskState;
  /** Implementing node (while assigned / in_progress). */
  nodeId?: string;
  /** QA node (while testing). */
  qaNodeId?: string;
  /** True once the QA node reported in_progress (tests actually started). */
  qaStarted?: boolean;
  /** Epoch ms when the owning node disconnected mid-job; the task is held for it until the grace period ends. */
  detachedAt?: number;
  attempts: number;
  qaAttempts: number;
  /** Times the task was taken away from a node that dropped off the network. */
  drops: number;
  reworkRound: number;
  rework?: Rework;
  /** Head of task/<id> reported by the implementer. */
  commit?: string;
  /** Merge commit on main. */
  mainCommit?: string;
  qaSetup?: string[][];
  /** Accumulated model usage for this task (estimated cost). */
  llm: { calls: number } & LlmUsage;
  /** Spend before the latest retry; the budget applies to what was spent since. */
  budgetBaseUsd?: number;
  /** Times a person retried this task. */
  retries?: number;
  /** Files the agent reported touching (FILE_OPERATION), most recent last. */
  filesTouched: string[];
  /** One line per model turn: what the agent did and what it cost. */
  agentLog: AgentTurn[];
  /** Plan that created this task, if any. */
  planId?: string;
  createdAt: string;
  updatedAt: string;
  waitingReason?: string;
  routing?: { nodeId: string; score: number; reasons: string[] };
  detail?: string;
  history: Array<{ at: string; event: string }>;
}

export interface AgentTurn {
  at: string;
  turn: number;
  actions: string[];
  costUsd: number;
}

const AGENT_LOG_LIMIT = 200;

export class TaskError extends Error {
  constructor(
    message: string,
    readonly code: "duplicate" | "invalid" | "not_found" | "conflict",
  ) {
    super(message);
  }
}

export interface QaOptions {
  /** When false, verified work is merged without a QA run. */
  enabled: boolean;
  command: string[];
  kind: TaskKind;
  timeoutSec: number;
  /** Setup steps before tests. Default: `npm ci` when the commit has a package-lock.json. */
  setup?: string[][];
}

export const DEFAULT_QA: QaOptions = { enabled: true, command: ["npm", "test"], kind: "unit_test", timeoutSec: 900 };

export interface TaskManagerOptions {
  /** The project these tasks belong to; sent to workers so they check out the right repository. */
  project?: string;
  /**
   * Called when work may have become dispatchable (a node freed up, a task requeued). With
   * several projects sharing the workers, this dispatches all of them; default: this one.
   */
  onDispatchNeeded?: () => void;
  /** Whether a task id is taken in any project: ids are unique across the Hub. */
  isIdTaken?: (taskId: string) => boolean;
  policies?: RoutingPolicies;
  /** Node drops tolerated per task before it is failed. */
  maxDrops?: number;
  /** QA infrastructure failures tolerated per task. */
  maxQaAttempts?: number;
  /** Rework rounds (failed QA / verification / merge conflict) before the task is failed. */
  maxReworkRounds?: number;
  /** How long a started job is held for a disconnected node before it is reassigned. */
  reclaimGraceMs?: number;
  qa?: Partial<QaOptions>;
  /** Called after a task is merged into main (e.g. to push main to GitHub). */
  onMerged?: (task: TaskRecord) => void;
  /** Called whenever a task record changes (used to persist Hub state). */
  onChange?: () => void;
  /** Receives task events and QA verdicts for the task's transcript. */
  onTranscript?: (taskId: string, entry: TranscriptInput) => void;
}

const HISTORY_LIMIT = 50;
const ACTIVE: ReadonlySet<TaskState> = new Set(["assigned", "in_progress", "testing"]);

/** Task queue and pipeline: routes work to workers, verifies pushes, runs QA, merges. */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly policies: RoutingPolicies;
  private readonly maxDrops: number;
  private readonly maxQaAttempts: number;
  private readonly maxReworkRounds: number;
  private readonly reclaimGraceMs: number;
  readonly qa: QaOptions;
  private readonly onMerged?: (task: TaskRecord) => void;
  private readonly onChange?: () => void;
  readonly project: string;
  private readonly onDispatchNeeded?: () => void;
  private readonly isIdTaken: (taskId: string) => boolean;
  private readonly onTranscript?: (taskId: string, entry: TranscriptInput) => void;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly repo: HubRepository,
    opts: TaskManagerOptions = {},
  ) {
    this.policies = opts.policies ?? DEFAULT_ROUTING_POLICIES;
    this.maxDrops = opts.maxDrops ?? 3;
    this.maxQaAttempts = opts.maxQaAttempts ?? 3;
    this.maxReworkRounds = opts.maxReworkRounds ?? 3;
    this.reclaimGraceMs = opts.reclaimGraceMs ?? 5 * 60_000;
    this.qa = { ...DEFAULT_QA, ...opts.qa };
    this.onMerged = opts.onMerged;
    this.onChange = opts.onChange;
    this.onTranscript = opts.onTranscript;
    this.project = opts.project ?? "project";
    this.onDispatchNeeded = opts.onDispatchNeeded;
    this.isIdTaken = opts.isIdTaken ?? ((id) => this.tasks.has(id));
  }

  private kick(): void {
    if (this.onDispatchNeeded) this.onDispatchNeeded();
    else this.dispatch();
  }

  /**
   * Stop a task. A node still working on it is fenced: its status updates, model calls and QA
   * results are refused from now on, so the job ends at its next model turn.
   */
  cancel(taskId: string): TaskRecord {
    const task = this.require(taskId);
    if (task.state === "merged" || task.state === "failed" || task.state === "cancelled") {
      throw new TaskError(`task ${taskId} is already ${task.state}`, "conflict");
    }
    if (task.state === "merging") throw new TaskError(`task ${taskId} is being merged right now`, "conflict");
    for (const nodeId of [task.nodeId, task.qaNodeId]) if (nodeId) this.registry.release(nodeId, taskId);
    task.state = "cancelled";
    task.detachedAt = undefined;
    task.qaNodeId = undefined;
    task.waitingReason = undefined;
    this.note(task, "cancelled by a person");
    this.kick();
    return task;
  }

  /**
   * Queue a failed or cancelled task again with fresh limits (rework rounds, node drops,
   * budget). Its branch keeps the previous attempt, and the agent is told why it failed.
   */
  retry(taskId: string): TaskRecord {
    const task = this.require(taskId);
    if (task.state !== "failed" && task.state !== "cancelled") {
      throw new TaskError(`task ${taskId} is ${task.state}; only failed or cancelled tasks can be retried`, "conflict");
    }
    const why = task.state === "failed" ? `the previous attempt failed: ${task.detail ?? "no detail"}` : "the previous attempt was cancelled";
    task.retries = (task.retries ?? 0) + 1;
    task.budgetBaseUsd = task.llm.costUsd;
    task.reworkRound = 0;
    task.drops = 0;
    task.qaAttempts = 0;
    task.nodeId = undefined;
    task.qaNodeId = undefined;
    task.commit = undefined;
    task.detail = undefined;
    task.rework = { round: 1, reason: `Retried by a person; ${why}. Your branch may already contain that attempt.` };
    task.state = "pending";
    this.note(task, `retry ${task.retries} requested by a person`);
    this.kick();
    return task;
  }

  /** What the task spent on the model since it was last retried (the budget applies to this). */
  spentSinceRetry(taskId: string): number {
    const task = this.tasks.get(taskId);
    return task ? task.llm.costUsd - (task.budgetBaseUsd ?? 0) : 0;
  }

  private require(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new TaskError(`task ${taskId} not found`, "not_found");
    return task;
  }

  /**
   * Load tasks saved before a Hub restart. Every node was disconnected by the restart, so work
   * in flight is treated like a disconnect: started jobs are held for their node to reclaim,
   * unstarted ones go back to the queue, and Hub-side steps (verify, merge) run again.
   * Not counted as a node drop: the Hub went away, not the node.
   */
  restore(records: readonly TaskRecord[], now = Date.now()): void {
    for (const record of records) {
      record.project ??= this.project; // saved before projects existed
      this.tasks.set(record.spec.taskId, record);
    }
    for (const task of records) {
      task.detachedAt = undefined;
      switch (task.state) {
        case "assigned":
        case "in_progress":
        case "testing": {
          const started = task.state === "testing" ? task.qaStarted : task.state === "in_progress";
          const owner = task.state === "testing" ? task.qaNodeId : task.nodeId;
          if (started) {
            task.detachedAt = now;
            this.note(task, `Hub restarted; holding for ${owner} to reconnect for ${Math.round(this.reclaimGraceMs / 1000)}s`);
          } else if (task.state === "testing") {
            task.qaNodeId = undefined;
            task.state = "awaiting_qa";
            this.note(task, "Hub restarted before QA started; requeued");
          } else {
            task.nodeId = undefined;
            task.state = "pending";
            this.note(task, "Hub restarted before work started; requeued");
          }
          break;
        }
        case "verifying":
          this.note(task, "Hub restarted; verifying again");
          void this.verify(task, task.commit!);
          break;
        case "merging":
          // Idempotent: a commit that already reached main merges as "already up to date".
          this.note(task, "Hub restarted; merging again");
          void this.merge(task);
          break;
      }
    }
    if (records.length) log.info(`restored ${records.length} task(s)`);
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /** Validate and queue a task. `input` is untrusted (API body / Architect output). */
  submit(input: unknown, origin: { planId?: string; idHint?: string } = {}): TaskRecord {
    const parsed = TaskSpecInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new TaskError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid");
    }
    const spec = TaskSpecSchema.parse({ ...parsed.data, taskId: parsed.data.taskId ?? this.generateId(origin.idHint ?? parsed.data.title) });
    if (this.isIdTaken(spec.taskId)) throw new TaskError(`task ${spec.taskId} already exists`, "duplicate");
    for (const dep of spec.dependsOn) {
      if (dep === spec.taskId) throw new TaskError("a task cannot depend on itself", "invalid");
      if (!this.tasks.has(dep)) throw new TaskError(`dependency ${dep} does not exist (submit it first)`, "invalid");
    }

    const now = new Date().toISOString();
    const task: TaskRecord = {
      spec,
      project: this.project,
      state: "pending",
      attempts: 0,
      qaAttempts: 0,
      drops: 0,
      reworkRound: 0,
      llm: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      filesTouched: [],
      agentLog: [],
      planId: origin.planId,
      createdAt: now,
      updatedAt: now,
      history: [],
    };
    this.tasks.set(spec.taskId, task);
    this.note(task, `queued (${spec.role}/${spec.kind})`);
    this.kick();
    return task;
  }

  /** Hand out pending implementation work and pending QA runs, oldest task first. */
  dispatch(): void {
    for (const task of this.tasks.values()) {
      if (task.state === "pending") this.dispatchImplementation(task);
      else if (task.state === "awaiting_qa") this.dispatchQa(task);
    }
  }

  private dispatchImplementation(task: TaskRecord): void {
    const unmet = task.spec.dependsOn.map((id) => this.tasks.get(id)!).filter((d) => d.state !== "merged");
    if (unmet.length) {
      const failed = unmet.filter((d) => d.state === "failed" || d.state === "cancelled").map((d) => d.spec.taskId);
      task.waitingReason = failed.length
        ? `blocked: dependency ${failed.join(", ")} failed or was cancelled`
        : `waiting for ${unmet.map((d) => d.spec.taskId).join(", ")} to be merged`;
      return;
    }
    const decision = selectNode({ role: task.spec.role, kind: task.spec.kind }, this.registry.workerSnapshots(), this.policies);
    if (!decision.ok) return this.wait(task, decision);

    this.registry.assign(decision.nodeId, task.spec.taskId);
    task.state = "assigned";
    task.nodeId = decision.nodeId;
    task.attempts++;
    task.waitingReason = undefined;
    task.routing = { nodeId: decision.nodeId, score: decision.score, reasons: decision.reasons };
    this.note(task, `assigned to ${decision.nodeId} (${decision.reasons.join(", ")})`);
    this.registry.send(decision.nodeId, "TASK_ASSIGNMENT", { ...task.spec, project: this.project, rework: task.rework });
  }

  private dispatchQa(task: TaskRecord): void {
    const decision = selectNode({ role: "qa", kind: this.qa.kind }, this.registry.workerSnapshots(), this.policies);
    if (!decision.ok) return this.wait(task, decision);

    this.registry.assign(decision.nodeId, task.spec.taskId);
    task.state = "testing";
    task.qaNodeId = decision.nodeId;
    task.qaStarted = false;
    task.qaAttempts++;
    task.waitingReason = undefined;
    this.note(task, `QA run on ${decision.nodeId} for ${task.commit!.slice(0, 8)}`);
    this.registry.send(decision.nodeId, "TEST_EXECUTION", {
      taskId: task.spec.taskId,
      project: this.project,
      commit: task.commit!,
      command: this.qa.command,
      setup: task.qaSetup ?? [],
      timeoutSec: this.qa.timeoutSec,
    });
  }

  private wait(task: TaskRecord, decision: Extract<ReturnType<typeof selectNode>, { ok: false }>): void {
    const reason = [decision.reason, ...decision.rejected.map((r) => `${r.nodeId}: ${r.reason}`)].join("; ");
    if (reason !== task.waitingReason) {
      task.waitingReason = reason;
      log.debug(`task ${task.spec.taskId} waiting: ${reason}`);
    }
  }

  /** True while `taskId` is assigned to `nodeId` for implementation, even if the node is briefly disconnected. */
  isHeldFor(nodeId: string, taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return !!task && task.nodeId === nodeId && (task.state === "assigned" || task.state === "in_progress");
  }

  /** True while `nodeId` is the connected implementer of `taskId`. */
  isImplementing(nodeId: string, taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return (
      !!task &&
      task.nodeId === nodeId &&
      (task.state === "assigned" || task.state === "in_progress") &&
      task.detachedAt === undefined
    );
  }

  recordLlmUsage(taskId: string, usage: LlmUsage): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const l = task.llm;
    l.calls++;
    l.inputTokens += usage.inputTokens;
    l.outputTokens += usage.outputTokens;
    l.cacheReadTokens += usage.cacheReadTokens;
    l.cacheWriteTokens += usage.cacheWriteTokens;
    l.costUsd = Math.round((l.costUsd + usage.costUsd) * 1e6) / 1e6;
    this.onChange?.();
  }

  recordAgentTurn(taskId: string, turn: Omit<AgentTurn, "at">): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.agentLog.push({ at: new Date().toISOString(), ...turn });
    if (task.agentLog.length > AGENT_LOG_LIMIT) task.agentLog.splice(0, task.agentLog.length - AGENT_LOG_LIMIT);
    this.onChange?.();
  }

  /** Track an agent's file edit. Returns an error string if the sender isn't implementing the task. */
  recordFileOperation(nodeId: string, op: MessageOf<"FILE_OPERATION">["payload"]): string | undefined {
    if (!this.isImplementing(nodeId, op.taskId)) return `task ${op.taskId} is not being implemented by ${nodeId}`;
    const task = this.tasks.get(op.taskId)!;
    for (const p of op.op === "rename" ? [op.path, op.newPath] : [op.path]) {
      const i = task.filesTouched.indexOf(p);
      if (i >= 0) task.filesTouched.splice(i, 1);
      task.filesTouched.push(p);
    }
    if (task.filesTouched.length > 500) task.filesTouched.splice(0, task.filesTouched.length - 500);
    this.touch(task);
    return undefined;
  }

  /** Add an entry to a task's history (used by other Hub components). */
  recordEvent(taskId: string, event: string): void {
    const task = this.tasks.get(taskId);
    if (task) this.note(task, event);
  }

  /** Apply a STATUS_UPDATE. Returns an error string if the sender does not own the task. */
  handleStatus(nodeId: string, update: MessageOf<"STATUS_UPDATE">["payload"]): string | undefined {
    if (update.taskId === undefined) return undefined; // idle keepalive
    const task = this.tasks.get(update.taskId);
    if (!task) return `unknown task ${update.taskId}`;
    if (update.state === "idle") return "idle status must not carry a taskId";

    if (task.state === "testing" && task.qaNodeId === nodeId) return this.handleQaStatus(task, nodeId, update);
    if ((task.state === "assigned" || task.state === "in_progress") && task.nodeId === nodeId) {
      return this.handleImplementerStatus(task, nodeId, update);
    }
    return `task ${update.taskId} is not assigned to ${nodeId}`;
  }

  private handleImplementerStatus(
    task: TaskRecord,
    nodeId: string,
    update: MessageOf<"STATUS_UPDATE">["payload"],
  ): string | undefined {
    if (update.detail) task.detail = update.detail;
    switch (update.state) {
      case "accepted":
        this.touch(task);
        return undefined;
      case "in_progress":
      case "waiting_dependency":
      case "waiting_llm":
        if (task.state !== "in_progress") this.note(task, `started on ${nodeId}`);
        task.state = "in_progress";
        this.touch(task);
        return undefined;
      case "completed":
        this.registry.release(nodeId, task.spec.taskId);
        task.state = "verifying";
        task.commit = update.commit;
        this.note(task, `pushed ${update.commit!.slice(0, 8)}${update.detail ? `: ${update.detail}` : ""}`);
        void this.verify(task, update.commit!);
        this.kick();
        return undefined;
      case "failed":
        this.registry.release(nodeId, task.spec.taskId);
        task.state = "failed";
        this.note(task, `failed on ${nodeId}: ${update.detail ?? "no detail"}`);
        this.kick();
        return undefined;
    }
    return undefined;
  }

  private handleQaStatus(
    task: TaskRecord,
    nodeId: string,
    update: MessageOf<"STATUS_UPDATE">["payload"],
  ): string | undefined {
    switch (update.state) {
      case "accepted":
        this.touch(task);
        return undefined;
      case "in_progress":
        task.qaStarted = true;
        this.touch(task);
        return undefined;
      case "failed":
        // The QA node could not run the tests at all (checkout, missing toolchain...).
        this.registry.release(nodeId, task.spec.taskId);
        task.qaNodeId = undefined;
        this.note(task, `QA node ${nodeId} could not run tests: ${update.detail ?? "no detail"}`);
        if (task.qaAttempts >= this.maxQaAttempts) this.fail(task, `QA could not run after ${task.qaAttempts} attempts`);
        else task.state = "awaiting_qa";
        this.kick();
        return undefined;
      default:
        return `QA nodes report results with FEEDBACK_LOOP, not STATUS_UPDATE ${update.state}`;
    }
  }

  /** Apply a QA verdict. Returns an error string if the sender is not running QA for the task. */
  handleFeedback(nodeId: string, feedback: Feedback): string | undefined {
    const task = this.tasks.get(feedback.taskId);
    if (!task || task.state !== "testing" || task.qaNodeId !== nodeId) {
      return `no QA run of ${feedback.taskId} is assigned to ${nodeId}`;
    }
    if (feedback.commit !== task.commit) return `QA result is for ${feedback.commit.slice(0, 8)}, expected ${task.commit!.slice(0, 8)}`;

    this.registry.release(nodeId, task.spec.taskId);
    task.qaNodeId = undefined;
    this.onTranscript?.(task.spec.taskId, {
      kind: "qa",
      outcome: feedback.outcome,
      summary: feedback.summary,
      output: feedback.outcome === "fail" ? feedback.output : undefined,
    });
    if (feedback.outcome === "pass") {
      this.note(task, `QA passed on ${nodeId}: ${feedback.summary}`);
      void this.merge(task);
    } else {
      this.note(task, `QA failed on ${nodeId}: ${feedback.summary}`);
      this.rework(task, `QA failed: ${feedback.summary}`, feedback.failures, feedback.output);
    }
    this.kick();
    return undefined;
  }

  /**
   * A node disconnected. Work it had not started yet is reassigned immediately; started work
   * is held for the node to reclaim (see nodeRegistered) until the grace period ends.
   */
  handleNodeGone(nodeId: string, now = Date.now()): void {
    for (const task of this.tasks.values()) {
      if (!ACTIVE.has(task.state) || task.detachedAt !== undefined) continue;
      const isImplementer = task.nodeId === nodeId && task.state !== "testing";
      const isQa = task.qaNodeId === nodeId && task.state === "testing";
      if (!isImplementer && !isQa) continue;

      const started = isQa ? task.qaStarted : task.state === "in_progress";
      if (started) {
        task.detachedAt = now;
        this.note(task, `${nodeId} disconnected mid-job; holding for ${Math.round(this.reclaimGraceMs / 1000)}s`);
      } else {
        this.requeue(task, `${nodeId} disconnected before starting`);
      }
    }
    this.kick();
  }

  /** A node (re)registered. Give back a held job it is still running; requeue ones it lost. */
  nodeRegistered(nodeId: string, resume?: { taskId: string; job: "implement" | "test" }): void {
    for (const task of this.tasks.values()) {
      if (task.detachedAt === undefined) continue;
      const owner = task.state === "testing" ? task.qaNodeId : task.nodeId;
      if (owner !== nodeId) continue;

      const job = task.state === "testing" ? "test" : "implement";
      if (resume?.taskId === task.spec.taskId && resume.job === job) {
        task.detachedAt = undefined;
        this.registry.assign(nodeId, task.spec.taskId);
        this.note(task, `${nodeId} reconnected and resumed`);
      } else {
        this.requeue(task, `${nodeId} reconnected without the job`);
      }
    }
  }

  /** Reassign held jobs whose node did not come back in time. */
  sweepDetached(now = Date.now()): void {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.detachedAt !== undefined && now - task.detachedAt >= this.reclaimGraceMs) {
        const owner = task.state === "testing" ? task.qaNodeId : task.nodeId;
        this.requeue(task, `${owner} did not return within the grace period`);
        changed = true;
      }
    }
    if (changed) this.kick();
  }

  private requeue(task: TaskRecord, reason: string): void {
    task.detachedAt = undefined;
    task.drops++;
    if (task.drops >= this.maxDrops) return this.fail(task, `${reason}; gave up after ${task.drops} node losses`);
    if (task.state === "testing") {
      task.qaNodeId = undefined;
      task.state = "awaiting_qa";
    } else {
      task.nodeId = undefined;
      task.state = "pending";
    }
    this.note(task, `requeued: ${reason}`);
  }

  private async verify(task: TaskRecord, commit: string): Promise<void> {
    let problem: string | undefined;
    try {
      problem = await this.repo.verifyTaskCommit(task.spec.taskId, commit, task.spec.role);
    } catch (err) {
      problem = `verification error: ${(err as Error).message}`;
    }
    if (task.state !== "verifying") return;
    if (problem) return this.rework(task, `push verification failed: ${problem}`);

    if (!this.qa.enabled) {
      this.note(task, "verified; QA disabled");
      return void this.merge(task);
    }
    task.qaSetup = this.qa.setup ?? ((await this.repo.fileExists(commit, "package-lock.json")) ? [["npm", "ci"]] : []);
    task.qaAttempts = 0;
    task.state = "awaiting_qa";
    this.note(task, "verified; awaiting QA");
    this.kick();
  }

  private async merge(task: TaskRecord): Promise<void> {
    task.state = "merging";
    this.touch(task);
    const result = await this.repo.merge(
      task.spec.taskId,
      task.commit!,
      `Merge task/${task.spec.taskId}: ${task.spec.title}`,
    );
    if (result.ok) {
      task.state = "merged";
      task.mainCommit = result.mainCommit;
      this.note(task, `merged into main @ ${result.mainCommit.slice(0, 8)}`);
      this.onMerged?.(task);
    } else if (result.conflict) {
      this.rework(task, `merge conflict with main in ${result.files.join(", ")}; rebase onto main and resolve`);
    } else {
      // Operator problem on the Hub (dirty checkout, wrong branch): no point reworking the code.
      this.fail(task, `merge blocked: ${result.reason}`);
    }
    this.kick();
  }

  private rework(task: TaskRecord, reason: string, failures: Rework["failures"] = [], output?: string): void {
    if (task.reworkRound >= this.maxReworkRounds) {
      return this.fail(task, `${reason} (gave up after ${task.reworkRound} rework rounds)`);
    }
    task.reworkRound++;
    task.rework = { round: task.reworkRound, reason, failures, output };
    task.state = "pending";
    task.nodeId = undefined;
    task.qaNodeId = undefined;
    task.commit = undefined;
    this.note(task, `rework round ${task.reworkRound}: ${reason}`);
    this.kick();
  }

  private fail(task: TaskRecord, reason: string): void {
    task.state = "failed";
    task.detail = reason;
    this.note(task, `failed: ${reason}`);
    log.warn(`task ${task.spec.taskId} failed: ${reason}`);
  }

  private note(task: TaskRecord, event: string): void {
    const at = new Date().toISOString();
    task.updatedAt = at;
    task.history.push({ at, event });
    if (task.history.length > HISTORY_LIMIT) task.history.splice(0, task.history.length - HISTORY_LIMIT);
    log.info(`task ${task.spec.taskId}: ${event}`);
    this.onTranscript?.(task.spec.taskId, { kind: "event", text: event });
    this.onChange?.();
  }

  private touch(task: TaskRecord): void {
    task.updatedAt = new Date().toISOString();
    this.onChange?.();
  }

  private generateId(title: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "");
    let id: string;
    do id = `${slug || "task"}-${randomBytes(3).toString("hex")}`;
    while (this.isIdTaken(id));
    return id;
  }
}
