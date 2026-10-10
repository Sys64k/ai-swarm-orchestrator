import { randomUUID } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Identifier a node picks for itself at boot; used as the envelope `from`. */
export const NodeIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/, "invalid node id");

/** Task ids double as git branch suffixes (`task/<id>`), so keep them ref-safe. */
export const TaskIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "task id must be lowercase alphanumerics and dashes (max 64)");
export type TaskId = z.infer<typeof TaskIdSchema>;

export const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "invalid commit sha");

/** Repository-relative POSIX path that cannot escape the repo or touch `.git`. */
export const RepoPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith("/") && !p.startsWith("~") && !p.includes("\\") && !p.includes("\0"), {
    message: "path must be relative",
  })
  .refine((p) => p.split("/").every((seg) => seg !== ".." && seg !== ".git"), {
    message: "path must not contain '..' or '.git' segments",
  });

/** npm package name rules (scoped or unscoped, lowercase, max 214 chars). */
export const NpmPackageNameSchema = z
  .string()
  .max(214)
  .regex(/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/, "invalid npm package name");

/** Semver range only: rejects URLs, git specs and file paths (no ':' or '/'). */
export const VersionRangeSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9.^~<>=|*+\- ]+$/, "invalid version range");

export const AGENT_ROLES = ["architect", "backend", "frontend", "qa", "devops"] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** Roles a worker node may execute (the Architect only runs on the Hub machine). */
export const WORKER_ROLES = ["backend", "frontend", "qa", "devops"] as const satisfies readonly AgentRole[];
export const WorkerRoleSchema = z.enum(WORKER_ROLES);
export type WorkerRole = z.infer<typeof WorkerRoleSchema>;

/**
 * What a task needs from hardware. The role decides *who* does the work; the kind decides
 * *where* it runs (e.g. e2e tests on high-RAM nodes, container builds on Docker hosts).
 */
export const TASK_KINDS = ["feature", "unit_test", "e2e_test", "db_migration", "container_build"] as const;
export const TaskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export function taskBranchName(taskId: TaskId): string {
  return `task/${TaskIdSchema.parse(taskId)}`;
}

// ---------------------------------------------------------------------------
// Hardware profile (sent in NODE_REGISTRATION, used for routing)
// ---------------------------------------------------------------------------

export const HardwareProfileSchema = z.strictObject({
  hostname: z.string().min(1),
  platform: z.string(),
  distro: z.string(),
  cpu: z.strictObject({
    brand: z.string(),
    physicalCores: z.number().int().nonnegative(),
    logicalCores: z.number().int().positive(),
  }),
  memory: z.strictObject({
    totalBytes: z.number().nonnegative(),
    availableBytes: z.number().nonnegative(),
  }),
  disks: z.array(
    z.strictObject({ name: z.string(), type: z.string(), sizeBytes: z.number().nonnegative() }),
  ),
  docker: z.strictObject({ available: z.boolean(), version: z.string().optional() }),
  /** Measured sequential write throughput (with fsync) of the worker's work directory. */
  storage: z.strictObject({ workDir: z.string().min(1), writeMBps: z.number().nonnegative() }),
});
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const NodeRegistrationPayload = z.discriminatedUnion("nodeKind", [
  z.strictObject({
    nodeKind: z.literal("worker"),
    version: z.string(),
    roles: z.array(WorkerRoleSchema).min(1),
    hardware: HardwareProfileSchema,
  }),
  z.strictObject({
    nodeKind: z.literal("architect"),
    version: z.string(),
  }),
]);

const RegistrationAckPayload = z.strictObject({
  nodeId: NodeIdSchema,
});

/** Live load metrics, sent periodically so routing uses current rather than boot-time values. */
const NodeHeartbeatPayload = z.strictObject({
  memoryAvailableBytes: z.number().nonnegative(),
  cpuLoadPercent: z.number().min(0).max(100),
  dockerAvailable: z.boolean(),
});

/** A unit of work as produced by the Architect (or submitted via the Hub API). */
export const TaskSpecSchema = z.strictObject({
  taskId: TaskIdSchema,
  role: WorkerRoleSchema,
  kind: TaskKindSchema.default("feature"),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(20_000),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  /** Optional hint of files the task is expected to touch. */
  files: z.array(RepoPathSchema).default([]),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** Task submission input: the Hub generates a task id when none is given. */
export const TaskSpecInputSchema = TaskSpecSchema.extend({ taskId: TaskIdSchema.optional() });
export type TaskSpecInput = z.input<typeof TaskSpecInputSchema>;

const TaskAssignmentPayload = TaskSpecSchema;

const TestExecutionPayload = z.strictObject({
  taskId: TaskIdSchema,
  /** Exact commit on `task/<id>` the QA worker must test. */
  commit: CommitShaSchema,
  /** argv for the test runner; executed without a shell. */
  command: z.array(z.string().min(1)).min(1).default(["npm", "test"]),
  timeoutSec: z.number().int().positive().max(3600).default(900),
});

const FileOperationPayload = z.discriminatedUnion("op", [
  z.strictObject({ taskId: TaskIdSchema, op: z.literal("create"), path: RepoPathSchema }),
  z.strictObject({ taskId: TaskIdSchema, op: z.literal("update"), path: RepoPathSchema }),
  z.strictObject({ taskId: TaskIdSchema, op: z.literal("delete"), path: RepoPathSchema }),
  z.strictObject({
    taskId: TaskIdSchema,
    op: z.literal("rename"),
    path: RepoPathSchema,
    newPath: RepoPathSchema,
  }),
]);

export const TASK_STATES = [
  "idle",
  "accepted",
  "in_progress",
  "waiting_dependency",
  "waiting_llm",
  "completed",
  "failed",
] as const;

const StatusUpdatePayload = z
  .strictObject({
    state: z.enum(TASK_STATES),
    taskId: TaskIdSchema.optional(),
    detail: z.string().max(2000).optional(),
    /** Set with `completed`: the pushed head of `task/<id>`. */
    commit: CommitShaSchema.optional(),
  })
  .refine((p) => p.state === "idle" || p.taskId !== undefined, {
    message: "taskId is required unless state is idle",
    path: ["taskId"],
  })
  .refine((p) => p.state !== "completed" || p.commit !== undefined, {
    message: "commit is required when state is completed",
    path: ["commit"],
  });

const TestFailure = z.strictObject({
  test: z.string().optional(),
  file: RepoPathSchema.optional(),
  message: z.string().min(1).max(10_000),
});

const FeedbackLoopPayload = z.discriminatedUnion("outcome", [
  z.strictObject({
    taskId: TaskIdSchema,
    commit: CommitShaSchema,
    outcome: z.literal("pass"),
    summary: z.string().max(5000),
  }),
  z.strictObject({
    taskId: TaskIdSchema,
    commit: CommitShaSchema,
    outcome: z.literal("fail"),
    summary: z.string().max(5000),
    failures: z.array(TestFailure).min(1),
    /** Tail of the runner output, truncated by the sender. */
    output: z.string().max(100_000).optional(),
  }),
]);

const DependencyRequestPayload = z.strictObject({
  requestId: z.uuid(),
  taskId: TaskIdSchema,
  name: NpmPackageNameSchema,
  version: VersionRangeSchema.optional(),
  dev: z.boolean().default(false),
});

const DependencyResponsePayload = z.discriminatedUnion("outcome", [
  z.strictObject({
    requestId: z.uuid(),
    outcome: z.literal("installed"),
    /** Commit on main containing the updated manifest + lockfile. */
    mainCommit: CommitShaSchema,
  }),
  z.strictObject({
    requestId: z.uuid(),
    outcome: z.literal("rejected"),
    reason: z.string().min(1),
  }),
]);

const PromptExecutionPayload = z.strictObject({
  requestId: z.uuid(),
  taskId: TaskIdSchema.optional(),
  /** The Hub selects the system prompt from the role; nodes cannot supply their own. */
  role: AgentRoleSchema,
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(500_000),
      }),
    )
    .min(1),
});

const PromptResultPayload = z.discriminatedUnion("outcome", [
  z.strictObject({
    requestId: z.uuid(),
    outcome: z.literal("ok"),
    content: z.string(),
    adapter: z.string(),
  }),
  z.strictObject({
    requestId: z.uuid(),
    outcome: z.literal("error"),
    error: z.string(),
    retryable: z.boolean(),
  }),
]);

const ProtocolErrorPayload = z.strictObject({
  /** Envelope id of the offending message, when it could be read. */
  refId: z.string().optional(),
  reason: z.string(),
  issues: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Envelope + discriminated union
// ---------------------------------------------------------------------------

/** Envelope `from` value the Hub uses for its own messages. */
export const HUB_NODE_ID = "hub";

function message<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({
    id: z.uuid(),
    from: NodeIdSchema,
    timestamp: z.iso.datetime(),
    type: z.literal(type),
    payload,
  });
}

export const AgentMessageSchema = z.discriminatedUnion("type", [
  message("NODE_REGISTRATION", NodeRegistrationPayload),
  message("REGISTRATION_ACK", RegistrationAckPayload),
  message("NODE_HEARTBEAT", NodeHeartbeatPayload),
  message("TASK_ASSIGNMENT", TaskAssignmentPayload),
  message("TEST_EXECUTION", TestExecutionPayload),
  message("FILE_OPERATION", FileOperationPayload),
  message("STATUS_UPDATE", StatusUpdatePayload),
  message("FEEDBACK_LOOP", FeedbackLoopPayload),
  message("DEPENDENCY_REQUEST", DependencyRequestPayload),
  message("DEPENDENCY_RESPONSE", DependencyResponsePayload),
  message("PROMPT_EXECUTION", PromptExecutionPayload),
  message("PROMPT_RESULT", PromptResultPayload),
  message("PROTOCOL_ERROR", ProtocolErrorPayload),
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type AgentMessageType = AgentMessage["type"];
export type MessageOf<T extends AgentMessageType> = Extract<AgentMessage, { type: T }>;
/** Payload as accepted by `createMessage` (fields with defaults may be omitted). */
export type PayloadInput<T extends AgentMessageType> = Extract<
  z.input<typeof AgentMessageSchema>,
  { type: T }
>["payload"];

/** Message types a node (worker or architect) may send to the Hub. */
export const NODE_TO_HUB_TYPES = new Set<AgentMessageType>([
  "NODE_REGISTRATION",
  "NODE_HEARTBEAT",
  "FILE_OPERATION",
  "STATUS_UPDATE",
  "FEEDBACK_LOOP",
  "DEPENDENCY_REQUEST",
  "PROMPT_EXECUTION",
]);

/** Message types only the Hub may send. */
export const HUB_TO_NODE_TYPES = new Set<AgentMessageType>([
  "REGISTRATION_ACK",
  "TASK_ASSIGNMENT",
  "TEST_EXECUTION",
  "DEPENDENCY_RESPONSE",
  "PROMPT_RESULT",
  "PROTOCOL_ERROR",
]);

/** Build and validate an outbound message. Throws if the payload is invalid. */
export function createMessage<T extends AgentMessageType>(
  type: T,
  from: string,
  payload: PayloadInput<T>,
): MessageOf<T> {
  return AgentMessageSchema.parse({
    id: randomUUID(),
    from,
    timestamp: new Date().toISOString(),
    type,
    payload,
  }) as MessageOf<T>;
}

export type ParseResult =
  | { ok: true; message: AgentMessage }
  | { ok: false; reason: string; issues: string[]; refId?: string };

/** Parse a raw WebSocket frame. Never throws. */
export function parseAgentMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "malformed JSON", issues: [] };
  }
  const result = AgentMessageSchema.safeParse(json);
  if (result.success) return { ok: true, message: result.data };

  const refId =
    typeof json === "object" && json !== null && typeof (json as { id?: unknown }).id === "string"
      ? (json as { id: string }).id
      : undefined;
  return {
    ok: false,
    reason: "schema validation failed",
    issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    refId,
  };
}
