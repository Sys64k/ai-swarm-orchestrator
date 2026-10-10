import { randomBytes } from "node:crypto";
import {
  TaskSpecInputSchema,
  TaskSpecSchema,
  createLogger,
  type MessageOf,
  type TaskSpec,
} from "@aso/shared";
import type { NodeRegistry } from "./registry.js";
import { DEFAULT_ROUTING_POLICIES, selectNode, type RoutingPolicies } from "./routing.js";

const log = createLogger("tasks");

export type TaskState = "pending" | "assigned" | "in_progress" | "completed" | "failed";

export interface TaskRecord {
  spec: TaskSpec;
  state: TaskState;
  nodeId?: string;
  /** Number of times the task was handed to a node. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** Why the task is still pending (no eligible node, etc.). */
  waitingReason?: string;
  routing?: { nodeId: string; score: number; reasons: string[] };
  detail?: string;
  commit?: string;
}

export class TaskError extends Error {
  constructor(
    message: string,
    readonly code: "duplicate" | "invalid",
  ) {
    super(message);
  }
}

export interface TaskManagerOptions {
  policies?: RoutingPolicies;
  /** Requeue limit when nodes drop mid-task. */
  maxAttempts?: number;
}

/** FIFO task queue that routes work to workers via the hardware-aware router. */
export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly policies: RoutingPolicies;
  private readonly maxAttempts: number;

  constructor(
    private readonly registry: NodeRegistry,
    opts: TaskManagerOptions = {},
  ) {
    this.policies = opts.policies ?? DEFAULT_ROUTING_POLICIES;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  /** Validate and queue a task. `input` is untrusted (API body / Architect output). */
  submit(input: unknown): TaskRecord {
    const parsed = TaskSpecInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new TaskError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), "invalid");
    }
    const spec = TaskSpecSchema.parse({ ...parsed.data, taskId: parsed.data.taskId ?? this.generateId(parsed.data.title) });
    if (this.tasks.has(spec.taskId)) throw new TaskError(`task ${spec.taskId} already exists`, "duplicate");

    const now = new Date().toISOString();
    const record: TaskRecord = { spec, state: "pending", attempts: 0, createdAt: now, updatedAt: now };
    this.tasks.set(spec.taskId, record);
    log.info(`queued ${spec.role}/${spec.kind} task ${spec.taskId}: ${spec.title}`);
    this.dispatch();
    return record;
  }

  /** Assign pending tasks (oldest first) to the best available nodes. */
  dispatch(): void {
    for (const task of this.tasks.values()) {
      if (task.state !== "pending") continue;
      const decision = selectNode(
        { role: task.spec.role, kind: task.spec.kind },
        this.registry.workerSnapshots(),
        this.policies,
      );
      if (!decision.ok) {
        const reason = [decision.reason, ...decision.rejected.map((r) => `${r.nodeId}: ${r.reason}`)].join("; ");
        if (reason !== task.waitingReason) {
          task.waitingReason = reason;
          log.debug(`task ${task.spec.taskId} waiting: ${reason}`);
        }
        continue;
      }

      this.registry.assign(decision.nodeId, task.spec.taskId);
      Object.assign(task, {
        state: "assigned",
        nodeId: decision.nodeId,
        attempts: task.attempts + 1,
        waitingReason: undefined,
        routing: { nodeId: decision.nodeId, score: decision.score, reasons: decision.reasons },
        updatedAt: new Date().toISOString(),
      } satisfies Partial<TaskRecord>);
      log.info(`assigned ${task.spec.taskId} -> ${decision.nodeId} (${decision.reasons.join(", ")})`);
      this.registry.send(decision.nodeId, "TASK_ASSIGNMENT", task.spec);
    }
  }

  /** Apply a STATUS_UPDATE from a node. Returns an error string if the update is not allowed. */
  handleStatus(nodeId: string, update: MessageOf<"STATUS_UPDATE">["payload"]): string | undefined {
    if (update.taskId === undefined) return undefined; // idle ping
    const task = this.tasks.get(update.taskId);
    if (!task) return `unknown task ${update.taskId}`;
    if (task.nodeId !== nodeId || (task.state !== "assigned" && task.state !== "in_progress")) {
      return `task ${update.taskId} is not assigned to ${nodeId}`;
    }

    task.updatedAt = new Date().toISOString();
    task.detail = update.detail ?? task.detail;
    switch (update.state) {
      case "accepted":
        break;
      case "in_progress":
      case "waiting_dependency":
      case "waiting_llm":
        task.state = "in_progress";
        break;
      case "completed":
        task.state = "completed";
        task.commit = update.commit;
        this.registry.release(nodeId, task.spec.taskId);
        break;
      case "failed":
        task.state = "failed";
        this.registry.release(nodeId, task.spec.taskId);
        break;
      case "idle":
        return "idle status must not carry a taskId";
    }
    log.info(`task ${task.spec.taskId} ${update.state} on ${nodeId}${update.detail ? `: ${update.detail}` : ""}`);
    if (task.state === "completed" || task.state === "failed") this.dispatch();
    return undefined;
  }

  /** A node disconnected: requeue its in-flight task (up to maxAttempts). */
  handleNodeGone(nodeId: string): void {
    for (const task of this.tasks.values()) {
      if (task.nodeId !== nodeId || (task.state !== "assigned" && task.state !== "in_progress")) continue;
      task.updatedAt = new Date().toISOString();
      task.nodeId = undefined;
      if (task.attempts >= this.maxAttempts) {
        task.state = "failed";
        task.detail = `node ${nodeId} disconnected; gave up after ${task.attempts} attempts`;
        log.warn(`task ${task.spec.taskId} failed: ${task.detail}`);
      } else {
        task.state = "pending";
        task.detail = `requeued after node ${nodeId} disconnected`;
        log.warn(`task ${task.spec.taskId} ${task.detail}`);
      }
    }
    this.dispatch();
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
    while (this.tasks.has(id));
    return id;
  }
}
