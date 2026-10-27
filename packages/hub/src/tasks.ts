import { randomBytes } from "node:crypto";
import {
  TaskSpecInputSchema,
  TaskSpecSchema,
  createLogger,
  type MessageOf,
  type ScreenshotTarget,
  type PayloadInput,
  type TaskKind,
  type LlmUsage,
  type TaskSpec,
  type TaskState,
  agentName,
  type CrewMemberSchema,
  type ReviewChecks,
  type Acceptance,
  type JobRecord,
  type JobResult,
} from "@aso/shared";
import { mergeBlock } from "./git/pull-requests.js";
import type { z } from "zod";
import type { PullRef } from "./git/github.js";
import type { HubRepository } from "./git/hub-repo.js";
import type { NodeRegistry } from "./registry.js";
import { DEFAULT_ROUTING_POLICIES, selectNode, type RoutingPolicies } from "./routing.js";
import type { TranscriptInput } from "./transcripts.js";
import type { Screenshots, ScreenshotSet } from "./screenshots.js";
import { acceptanceCounts, unmetReason, type AcceptanceChecker } from "./llm/acceptance.js";
import type { WorkerJob } from "./worker-scope.js";
import type { JobOutcome } from "./track-record.js";
import { addBuildUsage, endJob, failedBuildResult, markAcceptance, markQa, markVerified, openJob, startJob, type JobKind } from "./jobs.js";

const log = createLogger("tasks");

/**
 * pending → assigned → in_progress → verifying → awaiting_qa → testing → merging → merged
 * With pull requests, QA-approved work goes to awaiting_review instead of merging, and a person
 * merges it on GitHub or approves it in ASO (→ merged), requests changes there or in ASO
 * (→ pending, a review round) or closes it (→ cancelled).
 * Verification, QA or merge problems send the task back to pending as a rework round.
 * A person can cancel any task that isn't finished, and retry a failed or cancelled one.
 */
export type { TaskState } from "@aso/shared";

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
  /** Files the worker left with merge conflict markers when it brought the branch up to main. */
  conflicts?: string[];
  /** What the last passing QA run reported (shown in the pull request). */
  qaSummary?: string;
  /** The check of the work against the acceptance criteria, after QA passed. */
  acceptance?: Acceptance;
  /** What the project's screenshots script saved in the last passing QA run. */
  screenshots?: ScreenshotSet;
  /** The views the developer agent listed at its last finish, for QA's screenshots script. */
  screenshotTargets?: ScreenshotTarget[];
  /** The agents (machine and desk) that implemented and tested it, oldest first. */
  crew?: CrewMember[];
  /** Every job on it, oldest first, with what came of it: for track records (`job-report.ts`). */
  jobs?: JobRecord[];
  /** The pull request a person reviews, with pull requests on. */
  review?: ReviewInfo;
  qaSetup?: string[][];
  /** Accumulated model usage for this task (estimated cost). */
  llm: { calls: number } & LlmUsage;
  /** Spend before the latest retry; the budget applies to what was spent since. */
  budgetBaseUsd?: number;
  /** Times a person retried this task. */
  retries?: number;
  /** Its pull request may be merged without a person once it qualifies (see autoMergeReady): set on API syncs. */
  autoMerge?: boolean;
  /** A newer task that does this one's job (a newer sync of the API copy): this one is never run again. */
  supersededBy?: string;
  /** A commit the Hub itself made on the branch first (a sync task's new API copy): the acceptance check judges only what came after it. */
  diffBase?: string;
  /** Models whose API refused this task's requests (canonical specs); its later rounds use others. */
  refusedModels?: string[];
  /** Set when the current attempt's model was refused and another can take over: its failure requeues the task. */
  switchingModel?: boolean;
  /** Set when the current attempt's agent used all its turns: its failure becomes a rework round (escalation applies). */
  outOfTurns?: boolean;
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
  /** What the developer agent said it changed and how it checked it, at its last finish. */
  summary?: string;
  history: Array<{ at: string; event: string }>;
}

export type CrewMember = z.infer<typeof CrewMemberSchema>;

export interface ReviewInfo {
  /** The task's pull request, once it is open. */
  pr?: PullRef;
  /** Why opening or checking it last failed; the next check tries again. */
  error?: string;
  /** Times a reviewer requested changes (not limited, unlike rework rounds). */
  rounds: number;
  /** Reviews already acted on. */
  handled: number[];
}

/** What a person did with a task's pull request. */
export type ReviewOutcome =
  | { kind: "merged"; mainCommit: string; via?: "aso" }
  | { kind: "closed" }
  | { kind: "changes_requested"; reviewId: number; author: string; summary: string; details: string }
  | { kind: "conflict" };

/** Sends QA-approved work to a person for review (a GitHub pull request) instead of merging it. */
export interface ReviewGate {
  /** Push the task's branch and open its pull request, or update the open one. */
  open(task: TaskRecord): Promise<PullRef>;
  /** Close the task's pull request (the task was cancelled here). */
  close(task: TaskRecord, comment: string): Promise<void>;
  /** The pull request's CI checks, and whether it can merge. */
  checks(task: TaskRecord): Promise<ReviewChecks>;
  /** Merge the pull request at the commit QA passed and bring the Hub's main up to it; returns the merge commit. */
  merge(task: TaskRecord): Promise<string>;
  /** Record on the pull request that a person asked for changes in ASO. */
  noteChangesRequested(task: TaskRecord, message: string): Promise<void>;
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
    /** upstream: GitHub failed or refused. */
    readonly code: "duplicate" | "invalid" | "not_found" | "conflict" | "upstream",
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
  /** Why a machine may not take a job (its worker key's scope); undefined: it may. */
  refuseWorker?: (nodeId: string, job: WorkerJob) => string | undefined;
  /** What became of a machine's job, for its track record. */
  onOutcome?: (nodeId: string, outcome: JobOutcome) => void;
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
  /** With a gate, QA-approved work waits for a person's review instead of being merged. */
  reviewGate?: ReviewGate;
  /** Called whenever a task record changes (used to persist Hub state). */
  onChange?: () => void;
  /** Receives task events and QA verdicts for the task's transcript. */
  onTranscript?: (taskId: string, entry: TranscriptInput) => void;
  /** Keeps the screenshots of each task's last passing QA run. */
  screenshots?: Pick<Screenshots, "save" | "clear">;
  /** Checks QA-passed work against its acceptance criteria before it is merged or reviewed. */
  acceptance?: Pick<AcceptanceChecker, "check">;
}

const HISTORY_LIMIT = 50;
const now = () => new Date().toISOString();
const ACTIVE: ReadonlySet<TaskState> = new Set(["assigned", "in_progress", "testing"]);

/** Task queue and pipeline: routes work to workers, verifies pushes, runs QA, merges. */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly acceptance: TaskManagerOptions["acceptance"];
  private readonly policies: RoutingPolicies;
  private readonly maxDrops: number;
  private readonly maxQaAttempts: number;
  private readonly maxReworkRounds: number;
  private readonly refuseWorker?: TaskManagerOptions["refuseWorker"];
  private readonly onOutcome?: TaskManagerOptions["onOutcome"];
  private readonly reclaimGraceMs: number;
  readonly qa: QaOptions;
  private readonly onMerged?: (task: TaskRecord) => void;
  private readonly reviewGate?: ReviewGate;
  /** Tasks whose approval is merging their pull request right now. */
  private readonly approving = new Set<string>();
  private readonly onChange?: () => void;
  readonly project: string;
  private readonly onDispatchNeeded?: () => void;
  private readonly isIdTaken: (taskId: string) => boolean;
  private readonly onTranscript?: (taskId: string, entry: TranscriptInput) => void;
  private readonly screenshots?: Pick<Screenshots, "save" | "clear">;

  constructor(
    private readonly registry: NodeRegistry,
    private readonly repo: HubRepository,
    opts: TaskManagerOptions = {},
  ) {
    this.policies = opts.policies ?? DEFAULT_ROUTING_POLICIES;
    this.maxDrops = opts.maxDrops ?? 3;
    this.maxQaAttempts = opts.maxQaAttempts ?? 3;
    this.maxReworkRounds = opts.maxReworkRounds ?? 3;
    this.refuseWorker = opts.refuseWorker;
    this.onOutcome = opts.onOutcome;
    this.reclaimGraceMs = opts.reclaimGraceMs ?? 5 * 60_000;
    this.qa = { ...DEFAULT_QA, ...opts.qa };
    this.onMerged = opts.onMerged;
    this.reviewGate = opts.reviewGate;
    this.onChange = opts.onChange;
    this.onTranscript = opts.onTranscript;
    this.screenshots = opts.screenshots;
    this.acceptance = opts.acceptance;
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
    this.notApproving(taskId);
    for (const nodeId of [task.nodeId, task.qaNodeId]) if (nodeId) this.registry.release(nodeId, taskId);
    this.endJobs(task, "cancelled");
    // Its pull request may be open from an earlier round too (a rework underway).
    this.closeReview(task, "The task was cancelled from the ASO console.");
    task.state = "cancelled";
    task.detachedAt = undefined;
    task.qaNodeId = undefined;
    task.waitingReason = undefined;
    this.note(task, "cancelled by a person");
    this.kick();
    return task;
  }

  /** Close the task's pull request on GitHub, if it has one (in the background; a failure is logged). */
  private closeReview(task: TaskRecord, why: string): void {
    const pr = task.review?.pr;
    if (!pr || !this.reviewGate) return;
    this.reviewGate.close(task, why).catch((err: Error) => log.warn(`could not close pull request #${pr.number} of ${task.spec.taskId}: ${err.message}`));
  }

  /**
   * A newer task does this one's job: cancel it if it is still going, and mark it, finished or
   * not, so it isn't retried. Merged tasks are left alone.
   */
  supersede(taskId: string, by: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.state === "merged" || task.supersededBy) return;
    if (task.state !== "failed" && task.state !== "cancelled" && task.state !== "merging") {
      this.cancel(taskId);
    } else if (task.state === "failed") {
      this.closeReview(task, `Superseded by ${by}, which does this task's job.`);
    }
    task.supersededBy = by;
    this.note(task, `superseded by ${by}, which does its job`);
    this.onChange?.();
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
    if (task.supersededBy) throw new TaskError(`task ${taskId} was superseded by ${task.supersededBy}, which does its job; there's nothing to retry`, "conflict");
    const why = task.state === "failed" ? `the previous attempt failed: ${task.detail ?? "no detail"}` : "the previous attempt was cancelled";
    task.retries = (task.retries ?? 0) + 1;
    task.budgetBaseUsd = task.llm.costUsd;
    task.reworkRound = 0;
    task.drops = 0;
    // A person's retry gives every model another chance (a refusal may have been fixed since).
    task.refusedModels = undefined;
    task.switchingModel = undefined;
    task.outOfTurns = undefined;
    task.qaAttempts = 0;
    task.nodeId = undefined;
    task.qaNodeId = undefined;
    task.commit = undefined;
    task.detail = undefined;
    task.summary = undefined;
    // A failed task's pull request may still be open: close it, since the next attempt opens its own.
    if (task.state === "failed") this.closeReview(task, "The task is being retried; its next attempt opens a new pull request.");
    task.review = undefined;
    task.conflicts = undefined;
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
          const owner = jobOwner(task);
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
          if (task.acceptance?.result === "checking") {
            this.note(task, "Hub restarted; checking the acceptance criteria again");
            void this.checkAcceptance(task);
          } else {
            this.note(task, "Hub restarted; verifying again");
            void this.verify(task, task.commit!);
          }
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
  submit(input: unknown, origin: { planId?: string; idHint?: string; diffBase?: string; autoMerge?: boolean } = {}): TaskRecord {
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
      ...(origin.diffBase ? { diffBase: origin.diffBase } : {}),
      ...(origin.autoMerge ? { autoMerge: true } : {}),
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
    const refuse = (nodeId: string) => this.refuseWorker?.(nodeId, { project: this.project, job: "implement" });
    const decision = selectNode({ role: task.spec.role, kind: task.spec.kind, refuse }, this.registry.workerSnapshots(), this.policies);
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
    // QA on another machine than the implementer when one is free, so the tests run on a fresh checkout and setup.
    const refuse = (nodeId: string) => this.refuseWorker?.(nodeId, { project: this.project, job: "test" });
    const decision = selectNode({ role: "qa", kind: this.qa.kind, avoid: task.nodeId, refuse }, this.registry.workerSnapshots(), this.policies);
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
      ...(task.screenshotTargets?.length ? { screenshotTargets: task.screenshotTargets } : {}),
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

  /** A model call by the task's building agent: the task's usage, and its build's. */
  recordAgentUsage(taskId: string, usage: LlmUsage): void {
    addBuildUsage(this.tasks.get(taskId)?.jobs, usage.costUsd);
    this.recordLlmUsage(taskId, usage);
  }

  /** A model call made for the task (by its agent, or the acceptance check). */
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

  /**
   * A model's API refused this task's request, and another model can take over: the attempt's
   * failure (the worker reports it next) requeues the task instead of failing it, and later
   * rounds skip this model. It doesn't count as a rework round.
   */
  recordModelRefused(taskId: string, spec: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task || (task.state !== "assigned" && task.state !== "in_progress")) return;
    task.refusedModels = [...new Set([...(task.refusedModels ?? []), spec])];
    task.switchingModel = true;
    this.note(task, `${spec} refused the request (${error.split("\n")[0].slice(0, 160)}); the task moves to another model`);
  }

  /**
   * The task's agent used all its turns. Its work so far is saved on the branch, so the attempt's
   * failure (the worker reports it next) becomes a rework round that continues from there: it
   * counts toward the rework limit, so a task that keeps running out escalates to a stronger
   * model, and fails once the rounds are used up.
   */
  recordOutOfTurns(taskId: string, turns: number): void {
    const task = this.tasks.get(taskId);
    if (!task || (task.state !== "assigned" && task.state !== "in_progress")) return;
    task.outOfTurns = true;
    this.note(task, `the agent used all ${turns} turns before finishing; its work so far is kept, and a rework round continues from it`);
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
      case "waiting_llm": {
        const agent = update.slot ? this.joinCrew(task, "implement", nodeId, update.slot) : undefined;
        if (update.slot) this.startJob(task, "implement", nodeId, update.slot);
        if (task.state !== "in_progress") this.note(task, `started on ${nodeId}${agent ? ` (${agent})` : ""}`);
        if (update.conflicts?.length && !task.conflicts) {
          task.conflicts = update.conflicts;
          this.note(task, `main changed the same lines; conflict markers left for the agent in ${update.conflicts.join(", ")}`);
        }
        task.state = "in_progress";
        this.touch(task);
        return undefined;
      }
      case "completed":
        this.registry.release(nodeId, task.spec.taskId);
        endJob(task.jobs, "implement", "pushed", now());
        task.conflicts = undefined;
        task.state = "verifying";
        task.commit = update.commit;
        // Each finish lists the views anew: a rework's change may show elsewhere.
        task.screenshotTargets = update.screenshotTargets;
        task.summary = update.detail;
        this.note(task, `pushed ${update.commit!.slice(0, 8)}${update.detail ? `: ${update.detail}` : ""}`);
        void this.verify(task, update.commit!);
        this.kick();
        return undefined;
      case "failed":
        this.registry.release(nodeId, task.spec.taskId);
        endJob(task.jobs, "implement", failedBuildResult(task), now());
        if (task.switchingModel) {
          task.switchingModel = undefined;
          task.nodeId = undefined;
          task.state = "pending";
          this.note(task, `requeued for another model after the failure on ${nodeId}`);
        } else if (task.outOfTurns) {
          task.outOfTurns = undefined;
          this.rework(
            task,
            "The agent used all its turns before finishing. Its work so far is on this branch: continue from it, and spend your turns finishing what's left (checking the branch's diff first) rather than exploring the whole project again.",
          );
        } else {
          task.state = "failed";
          this.note(task, `failed on ${nodeId}: ${update.detail ?? "no detail"}`);
          this.onOutcome?.(nodeId, "failed");
        }
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
        if (update.slot) {
          this.joinCrew(task, "test", nodeId, update.slot);
          this.startJob(task, "test", nodeId, update.slot);
        }
        this.touch(task);
        return undefined;
      case "failed":
        // The QA node could not run the tests at all (checkout, missing toolchain...).
        this.registry.release(nodeId, task.spec.taskId);
        endJob(task.jobs, "test", "error", now());
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
    endJob(task.jobs, "test", feedback.outcome === "pass" ? "passed" : "qaFailed", now());
    markQa(task.jobs, feedback.outcome === "pass");
    task.qaNodeId = undefined;
    this.onOutcome?.(nodeId, "tested");
    if (task.nodeId) this.onOutcome?.(task.nodeId, feedback.outcome === "pass" ? "qaPassed" : "qaFailed");
    this.onTranscript?.(task.spec.taskId, {
      kind: "qa",
      outcome: feedback.outcome,
      summary: feedback.summary,
      output: feedback.outcome === "fail" ? feedback.output : undefined,
    });
    if (feedback.outcome === "pass") {
      this.note(task, `QA passed on ${nodeId}: ${feedback.summary}`);
      task.qaSummary = feedback.summary;
      if (feedback.screenshots?.length && this.screenshots) {
        task.screenshots = this.screenshots.save(task.spec.taskId, feedback.commit, feedback.screenshots);
      } else if (task.screenshots) {
        // Screenshots of an earlier commit would show a reviewer something this one may not do.
        this.screenshots?.clear(task.spec.taskId);
        task.screenshots = undefined;
      }
      this.approved(task);
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
        this.requeue(task, `${nodeId} disconnected before starting`, false);
      }
    }
    this.kick();
  }

  /** A node (re)registered. Give back held jobs it is still running; requeue ones it lost. */
  nodeRegistered(nodeId: string, running: ReadonlyArray<{ taskId: string; job: "implement" | "test" }>): void {
    for (const task of this.tasks.values()) {
      if (task.detachedAt === undefined) continue;
      const owner = jobOwner(task);
      if (owner !== nodeId) continue;

      const job = task.state === "testing" ? "test" : "implement";
      if (running.some((r) => r.taskId === task.spec.taskId && r.job === job)) {
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
        const owner = jobOwner(task);
        this.requeue(task, `${owner} did not return within the grace period`);
        changed = true;
      }
    }
    if (changed) this.kick();
  }

  /** Take a job from its node. `started`: it had begun (a drop counts against the machine); else it was only assigned. */
  private requeue(task: TaskRecord, reason: string, started = true): void {
    task.detachedAt = undefined;
    task.drops++;
    const owner = jobOwner(task);
    if (owner && started) this.onOutcome?.(owner, "dropped");
    if (started) endJob(task.jobs, task.state === "testing" ? "test" : "implement", "dropped", now());
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

  /** The model the task's building agent runs on now (its open build's). */
  recordJobModel(taskId: string, model: string): void {
    const build = openJob(this.tasks.get(taskId)?.jobs, "implement");
    if (build && build.model !== model) {
      build.model = model;
      this.onChange?.();
    }
  }

  /** A job begins on a worker's desk (the Hub's own nodes, like the Architect, do no jobs). */
  private startJob(task: TaskRecord, kind: JobKind, nodeId: string, slot: number): void {
    const reg = this.registry.get(nodeId)?.registration;
    if (reg?.nodeKind !== "worker") return;
    task.jobs = startJob(task.jobs, kind, { host: reg.hardware.hostname, slot, nodeId }, task.reworkRound + (task.review?.rounds ?? 0), now());
  }

  /** End whatever job is under way (the task is cancelled, or fails). */
  private endJobs(task: TaskRecord, result: JobResult): void {
    endJob(task.jobs, "implement", result, now());
    endJob(task.jobs, "test", result, now());
  }

  /**
   * Record the agent (machine and desk) doing a job on the task, unless it is the one already on
   * it. Returns its name.
   */
  private joinCrew(task: TaskRecord, job: CrewMember["job"], nodeId: string, slot: number): string | undefined {
    const reg = this.registry.get(nodeId)?.registration;
    if (reg?.nodeKind !== "worker") return undefined;
    const member: CrewMember = { job, host: reg.hardware.hostname, slot, nodeId, at: new Date().toISOString() };
    const crew = (task.crew ??= []);
    const last = [...crew].reverse().find((m) => m.job === job);
    if (!last || last.nodeId !== nodeId || last.slot !== slot) crew.push(member);
    return agentName(member);
  }

  private async verify(task: TaskRecord, commit: string): Promise<void> {
    let problem: string | undefined;
    try {
      problem = await this.repo.verifyTaskCommit(task.spec.taskId, commit, task.spec.role);
    } catch (err) {
      problem = `verification error: ${(err as Error).message}`;
    }
    if (task.state !== "verifying") return;
    markVerified(task.jobs, !problem);
    if (problem) return this.rework(task, `push verification failed: ${problem}`);
    // A build counts once its push checks out (the builder is still task.nodeId).
    if (task.nodeId) this.onOutcome?.(task.nodeId, "built");

    if (!this.qa.enabled) {
      this.note(task, "verified; QA disabled");
      task.qaSummary = "QA is off on this Hub";
      return this.approved(task);
    }
    task.qaSetup = this.qa.setup ?? ((await this.repo.fileExists(commit, "package-lock.json")) ? [["npm", "ci"]] : []);
    task.qaAttempts = 0;
    task.state = "awaiting_qa";
    this.note(task, "verified; awaiting QA");
    this.kick();
  }

  /**
   * QA-approved work: first checked against its acceptance criteria (when the Hub has a check
   * and the task has criteria), then on to review or merge.
   */
  private approved(task: TaskRecord): void {
    if (!this.acceptance || task.spec.acceptanceCriteria.length === 0) return this.release(task);
    task.state = "verifying";
    task.acceptance = { result: "checking", commit: task.commit!, at: new Date().toISOString() };
    this.note(task, "checking the work against its acceptance criteria");
    void this.checkAcceptance(task);
  }

  /** Run the acceptance check; unmet criteria send the work back, anything else lets it go on. */
  private async checkAcceptance(task: TaskRecord): Promise<void> {
    const commit = task.commit!;
    const diff = await this.repo.diff(commit, task.diffBase).catch(() => undefined);
    const verdict = await this.acceptance!.check(task, diff);
    // Cancelled, or a newer commit, while the model thought: this verdict is stale.
    if (task.state !== "verifying" || task.commit !== commit || task.acceptance?.result !== "checking") return;
    if (verdict.usage) this.recordLlmUsage(task.spec.taskId, verdict.usage);
    const at = new Date().toISOString();
    markAcceptance(task.jobs, verdict.result, { model: verdict.model, costUsd: verdict.usage?.costUsd });
    if (verdict.result === "undecided") {
      task.acceptance = { result: "undecided", commit, at, reason: verdict.reason, ...(verdict.model ? { model: verdict.model } : {}) };
      this.note(task, `acceptance check undecided (${verdict.reason}); going on`);
      return this.release(task);
    }
    task.acceptance = { result: verdict.result, commit, at, model: verdict.model, summary: verdict.summary, criteria: verdict.criteria };
    const counts = acceptanceCounts(verdict.criteria);
    this.note(task, `acceptance check: ${counts}`);
    if (task.nodeId) this.onOutcome?.(task.nodeId, verdict.result === "unmet" ? "unmet" : "accepted");
    if (verdict.result === "unmet") this.rework(task, unmetReason(verdict.criteria));
    else this.release(task);
    this.kick();
  }

  /** Work that passed QA (and the acceptance check): to a person's review when pull requests are on, else straight into main. */
  private release(task: TaskRecord): void {
    if (!this.reviewGate) return void this.merge(task);
    task.state = "awaiting_review";
    task.review ??= { rounds: 0, handled: [] };
    task.review.error = undefined; // a new commit: earlier failures are history
    this.note(task, task.review.pr ? `updating pull request #${task.review.pr.number}` : "opening a pull request for review");
    void this.openReview(task);
  }

  /**
   * Push the branch and open or update the task's pull request. A failure is kept on the task
   * and tried again by the next review check.
   */
  async openReview(task: TaskRecord): Promise<void> {
    if (!this.reviewGate || task.state !== "awaiting_review" || !task.review) return;
    const info = task.review;
    try {
      const pr = await this.reviewGate.open(task);
      if (task.state !== "awaiting_review") return;
      const opened = info.pr?.number !== pr.number;
      info.pr = pr;
      info.error = undefined;
      this.note(task, opened ? `pull request #${pr.number} opened for review: ${pr.url}` : `pull request #${pr.number} updated with ${task.commit?.slice(0, 8)}`);
    } catch (err) {
      this.reviewProblem(task, `could not ${info.pr ? "update" : "open"} the pull request`, (err as Error).message);
    }
  }

  /** Checking the task's pull request failed (GitHub unreachable...); the next check tries again. */
  reviewCheckFailed(taskId: string, message: string): void {
    const task = this.tasks.get(taskId);
    if (task?.state === "awaiting_review") this.reviewProblem(task, `could not check pull request #${task.review?.pr?.number}`, message);
  }

  /** Keep a review step's failure on the task; noted once per distinct message. */
  private reviewProblem(task: TaskRecord, what: string, message: string): void {
    if (!task.review || task.review.error === message) return;
    task.review.error = message;
    this.note(task, `${what} (will retry): ${message}`);
  }

  /** Apply what a person did with the task's pull request (from the review check). */
  applyReview(taskId: string, outcome: ReviewOutcome): void {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "awaiting_review" || !task.review?.pr) return;
    const pr = task.review.pr;
    task.review.error = undefined; // GitHub answered
    switch (outcome.kind) {
      case "merged":
        task.state = "merged";
        task.mainCommit = outcome.mainCommit;
        this.note(task, `pull request #${pr.number} merged ${outcome.via === "aso" ? "from ASO" : "on GitHub"} @ ${outcome.mainCommit.slice(0, 8)}`);
        this.onMerged?.(task);
        break;
      case "closed":
        task.state = "cancelled";
        this.note(task, `pull request #${pr.number} closed without merging; cancelled`);
        break;
      case "changes_requested":
        task.review.handled.push(outcome.reviewId);
        task.review.rounds++;
        this.note(task, `${outcome.author} asked for changes on pull request #${pr.number}`);
        this.sendBack(task, { reason: `Review round ${task.review.rounds}: ${outcome.summary}`, failures: [], output: outcome.details }, "back to an agent");
        break;
      case "conflict":
        this.rework(task, `pull request #${pr.number} conflicts with main; rebase onto main and resolve`);
        break;
    }
    this.kick();
  }

  /** The task under review, or why it can't be reviewed now. */
  private underReview(taskId: string): TaskRecord & { review: ReviewInfo & { pr: PullRef } } {
    const task = this.require(taskId);
    if (task.state !== "awaiting_review") throw new TaskError(`task ${taskId} is ${task.state}, not waiting for review`, "conflict");
    if (!this.reviewGate || !task.review?.pr) throw new TaskError(`task ${taskId} has no pull request yet`, "conflict");
    this.notApproving(taskId);
    return task as TaskRecord & { review: ReviewInfo & { pr: PullRef } };
  }

  /** While an approval merges the pull request, the task can't be cancelled or decided again. */
  private notApproving(taskId: string): void {
    if (this.approving.has(taskId)) throw new TaskError(`task ${taskId} is being merged right now`, "conflict");
  }

  private async checksOf(task: TaskRecord & { review: { pr: PullRef } }): Promise<ReviewChecks> {
    try {
      return await this.reviewGate!.checks(task);
    } catch (err) {
      throw new TaskError(`could not read pull request #${task.review.pr.number}: ${(err as Error).message}`, "upstream");
    }
  }

  /** The CI checks on the task's pull request. */
  async reviewChecks(taskId: string): Promise<ReviewChecks> {
    return this.checksOf(this.underReview(taskId));
  }

  /**
   * A person accepts the work: its pull request is merged on GitHub and the Hub's main follows.
   * Unless `force`, only when every check passed (or there are none) and it doesn't conflict.
   */
  async approve(taskId: string, opts: { force?: boolean } = {}): Promise<TaskRecord> {
    const task = this.underReview(taskId);
    const pr = task.review.pr;
    this.approving.add(taskId);
    try {
      const block = mergeBlock(await this.checksOf(task), task.commit, opts.force);
      if (block) throw new TaskError(block, "conflict");
      let mainCommit: string;
      try {
        mainCommit = await this.reviewGate!.merge(task);
      } catch (err) {
        throw new TaskError(`could not merge pull request #${pr.number}: ${(err as Error).message}`, "upstream");
      }
      this.applyReview(taskId, { kind: "merged", mainCommit, via: "aso" });
      return task;
    } finally {
      this.approving.delete(taskId);
    }
  }

  /** A person asks for changes in ASO: back to an agent as a review round, noted on the pull request. */
  requestChanges(taskId: string, message: string): TaskRecord {
    const task = this.underReview(taskId);
    const pr = task.review.pr;
    const text = message.trim();
    task.review.rounds++;
    this.note(task, `a person asked for changes on pull request #${pr.number} in ASO`);
    const firstLine = text.split("\n")[0];
    const reason = `Review round ${task.review.rounds}: a person asked for changes: ${firstLine.length > 500 ? `${firstLine.slice(0, 499)}…` : firstLine}`;
    this.reviewGate!.noteChangesRequested(task, text).catch((err: Error) =>
      log.warn(`could not note the change request on pull request #${pr.number} of ${taskId}: ${err.message}`),
    );
    this.sendBack(task, { reason, failures: [], output: `What the reviewer asked for:\n${text}` }, "back to an agent");
    return task;
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

  /** A problem with the work (failed QA, bad push, conflict): back to an agent, up to the rework limit. */
  private rework(task: TaskRecord, reason: string, failures: Rework["failures"] = [], output?: string): void {
    if (task.reworkRound >= this.maxReworkRounds) {
      return this.fail(task, `${reason} (gave up after ${task.reworkRound} rework rounds)`);
    }
    task.reworkRound++;
    this.sendBack(task, { reason, failures, output }, `rework round ${task.reworkRound}`);
  }

  /** Queue the task for an agent again, with why. Review rounds come here directly: they have no limit. */
  private sendBack(task: TaskRecord, rework: Omit<Rework, "round">, label: string): void {
    // The agent sees one running count of every time its work came back.
    task.rework = { round: task.reworkRound + (task.review?.rounds ?? 0), ...rework };
    task.conflicts = undefined; // the next round reports its own
    task.state = "pending";
    task.nodeId = undefined;
    task.qaNodeId = undefined;
    task.commit = undefined;
    this.note(task, `${label}: ${rework.reason}`);
    this.kick();
  }

  private fail(task: TaskRecord, reason: string): void {
    this.endJobs(task, "failed");
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

/** The node doing a task's current job: its QA node while testing, else its implementer. */
function jobOwner(task: TaskRecord): string | undefined {
  return task.state === "testing" ? task.qaNodeId : task.nodeId;
}
