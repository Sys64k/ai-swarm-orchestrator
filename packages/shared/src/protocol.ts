import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AGENT_SUMMARY_MAX, IMAGE_MAX_BYTES, IMAGE_MEDIA_TYPES, QA_SCREENSHOTS_MAX, QA_SCREENSHOTS_MAX_BYTES } from "./constants.js";
import { ChatAnswerSchema } from "./chat-stream.js";

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

/**
 * A project is a folder in the Hub's projects root; its id is the folder name. Restricted so it
 * is safe as a path segment, a URL segment and a directory name on workers.
 */
export const ProjectIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "project name must be lowercase letters, digits, dashes or underscores (max 64)");
export type ProjectId = z.infer<typeof ProjectIdSchema>;

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

/** Full ref name for a task branch; the only refs workers may push. */
export const TASK_REF_PATTERN = /^refs\/heads\/task\/[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Dependency manifests and lockfiles. Only the Hub may change these (on main, via the
 * DEPENDENCY_REQUEST flow); a task branch touching them anywhere in the tree is rejected,
 * by the worker's AgentGitClient and again by the Hub before QA.
 */
export const PROTECTED_FILENAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

export function isProtectedPath(repoPath: string): boolean {
  return PROTECTED_FILENAMES.has(repoPath.split("/").pop() ?? "");
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

/** Upper bound on a worker's parallel jobs. */
export const MAX_WORKER_SLOTS = 16;

/** Jobs a worker runs at once when it does not say (workers from before slots, and the Architect). */
export const DEFAULT_SLOTS = 1;

const ResumeClaimSchema = z.strictObject({ taskId: TaskIdSchema, job: z.enum(["implement", "test"]) });
export type ResumeClaim = z.infer<typeof ResumeClaimSchema>;

/** Service managers that start a worker again after it exits (so the Hub may restart it). */
export const SupervisorSchema = z.enum(["systemd"]);
export type Supervisor = z.infer<typeof SupervisorSchema>;

/** A model the worker's machine serves itself (an OpenAI-compatible server on it, e.g. Ollama). */
export const LocalModelSchema = z.strictObject({
  id: z.string().min(1).max(200),
  /** It accepts images (QA screenshots). */
  vision: z.boolean().optional(),
});
export type LocalModel = z.infer<typeof LocalModelSchema>;

const NodeRegistrationPayload = z.discriminatedUnion("nodeKind", [
  z.strictObject({
    nodeKind: z.literal("worker"),
    version: z.string(),
    /** Sent by workers before roles became the Architect's call; ignored. */
    roles: z.array(WorkerRoleSchema).optional(),
    /** Set when a service manager starts the worker again after it exits, so the Hub can restart it. */
    supervisor: SupervisorSchema.optional(),
    /**
     * Set when the worker can update itself on NODE_CONTROL update: `package` installs the
     * package the Hub serves, then exits for its service manager to start the new build.
     */
    updates: z.enum(["package"]).optional(),
    hardware: HardwareProfileSchema,
    /** Jobs the worker runs at once, each in its own checkout. Absent (older workers): 1. */
    slots: z.number().int().min(1).max(MAX_WORKER_SLOTS).optional(),
    /** Jobs the worker is still running after a reconnect; lets the Hub hand them back. */
    running: z.array(ResumeClaimSchema).max(MAX_WORKER_SLOTS).optional(),
    /** The single running job, as workers sent it before slots. */
    resume: ResumeClaimSchema.optional(),
    /** Models this machine serves itself; the Hub may call them for this machine's own jobs (MODEL_CALL). */
    localModels: z.array(LocalModelSchema).max(50).optional(),
    /** Which of them this machine's desks use when the Hub hasn't put a desk on another model. */
    defaultLocalModel: z.string().min(1).max(200).optional(),
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
/** How hard a task is: 1 (one function) to 5 (a change across packages). */
export const TASK_LEVELS = [1, 2, 3, 4, 5] as const;
export const TaskLevelSchema = z.number().int().min(TASK_LEVELS[0]).max(TASK_LEVELS[TASK_LEVELS.length - 1]);

export const TaskSpecSchema = z.strictObject({
  taskId: TaskIdSchema,
  role: WorkerRoleSchema,
  kind: TaskKindSchema.default("feature"),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(20_000),
  acceptanceCriteria: z.array(z.string().min(1)).default([]),
  /** Optional hint of files the task is expected to touch. */
  files: z.array(RepoPathSchema).default([]),
  /** Tasks that must be merged into main before this one starts. */
  dependsOn: z.array(TaskIdSchema).max(20).default([]),
  /** How hard the task is (TASK_LEVELS): track records group by it. */
  level: TaskLevelSchema.optional(),
  /** A model every build of the task runs on: no escalation, no trial. The Hub keeps it as the spec it resolves to (`<provider>/<model>`). */
  model: z.string().min(1).max(200).optional(),
  /** Tests first: the Architect's model writes the tests, then the builder makes them pass without changing them. */
  testsFirst: z.boolean().optional(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** Plan ids identify one Architect planning run. */
export const PlanIdSchema = z.string().regex(/^plan-[a-z0-9]{6,32}$/, "invalid plan id");

/**
 * A task as proposed by the Architect. `key` is a plan-local name that `dependsOn` refers to;
 * the Hub assigns real task ids when the plan is approved.
 */
export const PlannedTaskSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "key must be lowercase alphanumerics and dashes"),
  role: WorkerRoleSchema,
  kind: TaskKindSchema.default("feature"),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(20_000),
  acceptanceCriteria: z.array(z.string().min(1)).max(20).default([]),
  files: z.array(RepoPathSchema).max(50).default([]),
  dependsOn: z.array(z.string()).max(20).default([]),
  testsFirst: z
    .boolean()
    .optional()
    .describe("Logic whose correctness lives in edge cases: the Architect's model writes its tests first, and the builder makes them pass without changing them"),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

/** Task submission input: the Hub generates a task id when none is given. */
export const TaskSpecInputSchema = TaskSpecSchema.extend({ taskId: TaskIdSchema.optional() });
export type TaskSpecInput = z.input<typeof TaskSpecInputSchema>;

const TestFailure = z.strictObject({
  test: z.string().optional(),
  file: RepoPathSchema.optional(),
  message: z.string().min(1).max(10_000),
});

const TaskAssignmentPayload = TaskSpecSchema.extend({
  /** The project the task belongs to: the worker checks out `/git/<project>.git`. */
  project: ProjectIdSchema,
  /** Present when the task comes back after a failed QA run, verification or merge. */
  rework: z
    .strictObject({
      round: z.number().int().positive(),
      reason: z.string().min(1).max(5000),
      failures: z.array(TestFailure).default([]),
      output: z.string().max(100_000).optional(),
    })
    .optional(),
});

/**
 * A view a developer agent asks QA to screenshot, because its change shows there. The project's
 * screenshots script reads the list (SCREENSHOT_TARGETS_ENV) and saves each as `<name>.png`.
 */
export const ScreenshotTargetSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,59}$/, "lowercase letters, digits and -, up to 60")
    .describe("File name without extension, e.g. task-screenshots-dark-phone"),
  path: z
    .string()
    .max(500)
    .regex(/^\/[^\s]*$/, "a path in the app starting with /, no spaces")
    .describe("Page to open, e.g. /tasks/t-1"),
  theme: z.enum(["light", "dark"]).optional().describe("Colour scheme; the app's default without one"),
  width: z.number().int().min(320).max(3840).optional().describe("Viewport width in CSS pixels, e.g. 412 for a phone; desktop size without one"),
  height: z.number().int().min(320).max(3840).optional().describe("Viewport height in CSS pixels"),
  selector: z.string().min(1).max(300).optional().describe("CSS selector of the element to shoot; the whole viewport without one"),
  state: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Data the page needs, in the project's own terms (e.g. a mock scenario name), if its screenshots script supports one"),
});
export type ScreenshotTarget = z.infer<typeof ScreenshotTargetSchema>;

export const ScreenshotTargetsSchema = z
  .array(ScreenshotTargetSchema)
  .min(1)
  .max(QA_SCREENSHOTS_MAX)
  .refine((list) => new Set(list.map((t) => t.name)).size === list.length, { message: "screenshot names must be unique" });

const TestExecutionPayload = z.strictObject({
  taskId: TaskIdSchema,
  project: ProjectIdSchema,
  /** Exact commit on `task/<id>` the QA worker must test. */
  commit: CommitShaSchema,
  /** argv for the test runner; executed without a shell. */
  command: z.array(z.string().min(1)).min(1).default(["npm", "test"]),
  /** argv lists run before the tests (e.g. `npm ci`); a failing step fails the run. */
  setup: z.array(z.array(z.string().min(1)).min(1)).default([]),
  timeoutSec: z.number().int().positive().max(3600).default(900),
  /** The views the developer agent listed for the screenshots script (see SCREENSHOT_TARGETS_ENV). */
  screenshotTargets: ScreenshotTargetsSchema.optional(),
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
    /** With `completed`, the agent's summary of the change, so it holds a whole one. */
    detail: z.string().max(AGENT_SUMMARY_MAX).optional(),
    /** Set with `completed`: the pushed head of `task/<id>`. */
    commit: CommitShaSchema.optional(),
    /** The job slot (desk) running the job, from 1; sent with `in_progress`. */
    slot: z.number().int().min(1).max(MAX_WORKER_SLOTS).optional(),
    /**
     * Sent with `in_progress` when bringing the branch up to main conflicted: the files left
     * with conflict markers for the agent to resolve.
     */
    conflicts: z.array(z.string().min(1).max(1000)).max(500).optional(),
    /** Sent with `completed`: the views the agent asks QA to screenshot. */
    screenshotTargets: ScreenshotTargetsSchema.optional(),
    /** Sent with `failed`: the agent gave up (stopped without finishing, saying why); its work so far is saved. */
    gaveUp: z.boolean().optional(),
  })
  .refine((p) => p.state === "idle" || p.taskId !== undefined, {
    message: "taskId is required unless state is idle",
    path: ["taskId"],
  })
  .refine((p) => p.state !== "completed" || p.commit !== undefined, {
    message: "commit is required when state is completed",
    path: ["commit"],
  });


/** A screenshot's file name: also its URL segment and its file on the Hub, so kept plain. */
export const ScreenshotNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "screenshot names are letters, digits and ._- (up to 100)");

const ScreenshotSchema = z.strictObject({
  name: ScreenshotNameSchema,
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  data: z.base64().max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4),
});

const FeedbackLoopPayload = z.discriminatedUnion("outcome", [
  z.strictObject({
    taskId: TaskIdSchema,
    commit: CommitShaSchema,
    outcome: z.literal("pass"),
    summary: z.string().max(5000),
    /** What the project's screenshots script saved, in name order (see SCREENSHOT_SCRIPT). */
    screenshots: z
      .array(ScreenshotSchema)
      .max(QA_SCREENSHOTS_MAX)
      .refine((list) => new Set(list.map((s) => s.name)).size === list.length, { message: "screenshot names must be unique" })
      .refine((list) => list.reduce((n, s) => n + s.data.length, 0) <= Math.ceil(QA_SCREENSHOTS_MAX_BYTES / 3) * 4, {
        message: `screenshots may hold at most ${QA_SCREENSHOTS_MAX_BYTES / 1_000_000} MB together`,
      })
      .optional(),
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

/** npm runs these automatically during install; agents may not define them. */
export const LIFECYCLE_SCRIPTS: ReadonlySet<string> = new Set([
  "preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare",
  "prepack", "postpack", "dependencies",
]);

export const ScriptNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9:_-]{0,40}$/, "script names are lowercase letters, digits and :_-")
  .refine((n) => !LIFECYCLE_SCRIPTS.has(n), { message: "install lifecycle scripts are not allowed" });

export const ScriptCommandSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((c) => !/[\r\n]/.test(c), { message: "script commands must be a single line" });

/**
 * A change to package.json that only the Hub may make (on main). If the project has no
 * package.json yet, the Hub creates a minimal one first.
 */
export const DependencySpecSchema = z.strictObject({
  name: NpmPackageNameSchema,
  version: VersionRangeSchema.optional(),
  dev: z.boolean().default(false),
});

/** Most packages one request may add: a scaffold needs a dozen or more at once. */
export const MAX_PACKAGES_PER_REQUEST = 30;

/** 1..MAX_PACKAGES_PER_REQUEST packages, each named once. */
export const DependencySpecListSchema = z
  .array(DependencySpecSchema)
  .min(1)
  .max(MAX_PACKAGES_PER_REQUEST)
  .refine((list) => new Set(list.map((p) => p.name)).size === list.length, { message: "each package may appear only once" });

export const PackageChangeSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("add_dependencies"),
    packages: DependencySpecListSchema,
  }),
  z.strictObject({
    type: z.literal("set_scripts"),
    scripts: z
      .record(ScriptNameSchema, ScriptCommandSchema)
      .refine((s) => Object.keys(s).length >= 1 && Object.keys(s).length <= 10, { message: "set 1 to 10 scripts" }),
  }),
]);
export type PackageChange = z.infer<typeof PackageChangeSchema>;

const DependencyRequestPayload = z.strictObject({
  requestId: z.uuid(),
  taskId: TaskIdSchema,
  change: PackageChangeSchema,
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

/**
 * One turn of an agent conversation. The Hub holds the conversation (system prompt, task,
 * every model message including thinking blocks); the worker only sends the results of the
 * tool calls the model made in the previous turn. Turn 0 starts the conversation.
 */
const PromptExecutionPayload = z
  .strictObject({
    requestId: z.uuid(),
    /** Exactly one of taskId (implementation) or planId (Architect planning). */
    taskId: TaskIdSchema.optional(),
    planId: PlanIdSchema.optional(),
    conversationId: z.uuid(),
    turn: z.number().int().min(0),
    toolResults: z
      .array(
        z.strictObject({
          toolUseId: z.string().min(1).max(200),
          content: z.string().max(200_000),
          isError: z.boolean().default(false),
          /** An image the tool returned (view_image), base64-encoded, shown to the model with the text. */
          image: z
            .strictObject({
              mediaType: z.enum(IMAGE_MEDIA_TYPES),
              data: z.base64().max(Math.ceil(IMAGE_MAX_BYTES / 3) * 4),
            })
            .optional(),
        }),
      )
      .max(64)
      .default([]),
  })
  .refine((p) => (p.taskId === undefined) !== (p.planId === undefined), {
    message: "exactly one of taskId or planId is required",
  });

export const LlmUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Estimate from the Hub's price table. */
  costUsd: z.number().nonnegative(),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

const PromptResultPayload = z.discriminatedUnion("outcome", [
  z.strictObject({
    requestId: z.uuid(),
    outcome: z.literal("ok"),
    conversationId: z.uuid(),
    turn: z.number().int().min(0),
    /** Visible text the model wrote this turn. */
    text: z.string(),
    toolCalls: z.array(
      z.strictObject({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
    ),
    stopReason: z.string(),
    usage: LlmUsageSchema,
  }),
  z.strictObject({
    requestId: z.uuid(),
    outcome: z.literal("error"),
    error: z.string(),
    retryable: z.boolean(),
    /** The Hub is waiting (e.g. for model credit): ask again later, without counting it as a retry. */
    paused: z.boolean().optional(),
  }),
]);

/** Questions the Architect may ask in one round. */
export const PLAN_QUESTIONS_MAX = 5;

/** Hub → Architect: turn a requirement into a plan. */
const PlanRequestPayload = z.strictObject({
  planId: PlanIdSchema,
  project: ProjectIdSchema,
  requirement: z.string().min(1).max(50_000),
  /** Planning round: 0, then one more after each reply from the person. */
  round: z.number().int().min(0).optional(),
});

/** Architect → Hub: the proposed tasks, questions for the human, or why planning failed. */
const PlanResultPayload = z.discriminatedUnion("outcome", [
  z.strictObject({
    planId: PlanIdSchema,
    outcome: z.literal("proposed"),
    summary: z.string().min(1).max(10_000),
    tasks: z.array(PlannedTaskSchema).min(1).max(25),
  }),
  z.strictObject({
    planId: PlanIdSchema,
    outcome: z.literal("questions"),
    questions: z.array(z.string().min(1).max(1000)).min(1).max(PLAN_QUESTIONS_MAX),
    context: z.string().max(2000).optional(),
  }),
  z.strictObject({ planId: PlanIdSchema, outcome: z.literal("failed"), error: z.string().min(1).max(5000) }),
]);

/**
 * The Hub asks a node to act on itself, only while it is idle. `restart`: exit so its service
 * manager starts it again. `update`: install the build the Hub serves (`version`), then restart.
 */
const NodeControlPayload = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("restart") }),
  z.strictObject({ action: z.literal("update"), version: z.string().min(1).max(200) }),
]);

/** A worker could not install the build the Hub asked for; it carries on with the one it has. */
const UpdateFailedPayload = z.strictObject({
  version: z.string().min(1).max(200),
  reason: z.string().min(1).max(2000),
});

const ProtocolErrorPayload = z.strictObject({
  /** Envelope id of the offending message, when it could be read. */
  refId: z.string().optional(),
  reason: z.string(),
  issues: z.array(z.string()).default([]),
});

/** The jobs a registering worker still runs: `running`, or the single `resume` of older workers. */
export function runningJobsOf(registration: z.infer<typeof NodeRegistrationPayload>): ResumeClaim[] {
  if (registration.nodeKind !== "worker") return [];
  return registration.running ?? (registration.resume ? [registration.resume] : []);
}

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

/** Hub → worker: call one of the worker's own local models with this Chat Completions request. */
const ModelCallPayload = z.strictObject({
  callId: z.uuid(),
  /** One of the models the worker listed in its registration. */
  model: z.string().min(1).max(200),
  /** The Chat Completions request body (messages, tools, token limit); the worker streams it. */
  request: z.record(z.string(), z.unknown()),
});

/** Worker → Hub: the answer to a MODEL_CALL, added up from the stream, or why there is none. */
const ModelAnswerPayload = z.discriminatedUnion("outcome", [
  z.strictObject({ callId: z.uuid(), outcome: z.literal("ok"), answer: ChatAnswerSchema }),
  z.strictObject({
    callId: z.uuid(),
    outcome: z.literal("error"),
    error: z.string().min(1).max(5000),
    /** The same call may work if made again (the server was busy or briefly unreachable). */
    retryable: z.boolean(),
  }),
]);

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
  message("PLAN_REQUEST", PlanRequestPayload),
  message("PLAN_RESULT", PlanResultPayload),
  message("NODE_CONTROL", NodeControlPayload),
  message("UPDATE_FAILED", UpdateFailedPayload),
  message("PROTOCOL_ERROR", ProtocolErrorPayload),
  message("MODEL_CALL", ModelCallPayload),
  message("MODEL_ANSWER", ModelAnswerPayload),
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
  "PLAN_RESULT",
  "UPDATE_FAILED",
  "MODEL_ANSWER",
]);

/** Message types only the Hub may send. */
export const HUB_TO_NODE_TYPES = new Set<AgentMessageType>([
  "REGISTRATION_ACK",
  "TASK_ASSIGNMENT",
  "TEST_EXECUTION",
  "DEPENDENCY_RESPONSE",
  "PROMPT_RESULT",
  "PLAN_REQUEST",
  "NODE_CONTROL",
  "PROTOCOL_ERROR",
  "MODEL_CALL",
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
