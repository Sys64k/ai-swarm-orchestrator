import { z } from "zod";
import { DiscoveryClaimSchema, DiscoveryKeyIdSchema } from "./discovery.js";
import { MAX_PLAN_REPLY_LENGTH } from "./plan-dialogue.js";
import { HardwareProfileSchema, LlmUsageSchema, PlannedTaskSchema, ProjectIdSchema, SupervisorSchema, TaskSpecInputSchema, TaskSpecSchema } from "./protocol.js";

/**
 * The Hub's HTTP API as data: what each request sends and what each answer holds. The Hub
 * validates request bodies with these schemas and builds its OpenAPI description from them,
 * and tests check its answers against them, so this file is the API's contract for any client
 * (the console, the CLI, or a separate UI).
 *
 * Answers are open objects: a newer Hub may add fields, and clients ignore what they don't know.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const TaskStateSchema = z.enum([
  "pending",
  "assigned",
  "in_progress",
  "verifying",
  "awaiting_qa",
  "testing",
  "merging",
  "awaiting_review",
  "merged",
  "failed",
  "cancelled",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Whether someone is at work on a task in each state (a worker, QA, the Hub merging it), so a
 * Hub restart would interrupt it. A map over every state: a new state must say.
 */
export const TASK_AT_WORK: Readonly<Record<TaskState, boolean>> = {
  pending: false,
  assigned: true,
  in_progress: true,
  verifying: true,
  awaiting_qa: true,
  testing: true,
  merging: true,
  awaiting_review: false,
  merged: false,
  failed: false,
  cancelled: false,
};

export const PlanStateSchema = z.enum(["pending", "planning", "awaiting_input", "proposed", "approved", "rejected", "failed"]);
export type PlanState = z.infer<typeof PlanStateSchema>;

const Timestamp = z.string().describe("ISO 8601 time");
const HistorySchema = z.array(z.object({ at: Timestamp, event: z.string() }));
const UsageSchema = LlmUsageSchema.extend({ calls: z.number().int() });
const AgentTurnSchema = z.object({ at: Timestamp, turn: z.number().int(), actions: z.array(z.string()), costUsd: z.number() });

/** The longest requirement a plan takes. */
export const MAX_REQUIREMENT_LENGTH = 50_000;
/** The longest change request a person sends back with a task under review. */
export const MAX_CHANGE_REQUEST_LENGTH = 10_000;

/**
 * An agent is one job slot (desk) of a worker machine, named after both: `avalon #2`. The name
 * stays when the worker restarts, unlike its node id.
 */
export function agentName(agent: { host: string; slot: number }): string {
  return `${agent.host} #${agent.slot}`;
}

export const CrewMemberSchema = z
  .object({
    job: z.enum(["implement", "test"]),
    host: z.string().describe("The worker machine's hostname"),
    slot: z.number().int().describe("The job slot (desk) on it, from 1"),
    nodeId: z.string().describe("The worker's node id at the time (changes when it restarts)"),
    at: Timestamp.describe("When this agent started on it"),
  })
  .describe("An agent that worked on a task: one per implementation round or QA run on a new desk");

export const ApiErrorSchema = z.object({ error: z.string() }).describe("Why the request failed");

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const CreateProjectBodySchema = z.object({
  name: ProjectIdSchema,
  github: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .optional()
    .describe("A GitHub repository (`owner/repo` or its URL) to connect: its code if it has any, and pull requests. The Hub's token must reach it"),
});
export const CreatePlanBodySchema = z.object({
  /** Needed when the Hub has more than one project. */
  project: ProjectIdSchema.optional(),
  requirement: z.string().min(1).max(MAX_REQUIREMENT_LENGTH).describe("What to build, in plain words"),
});
export const PlanReplyBodySchema = z.object({ message: z.string().min(1).max(MAX_PLAN_REPLY_LENGTH) });
export const CreateTaskBodySchema = TaskSpecInputSchema.extend({ project: ProjectIdSchema.optional() });
export const SyncBodySchema = z.object({ project: ProjectIdSchema.optional() });
export const RedeemSignInCodeBodySchema = z.object({ code: z.string().min(1).max(200) });
export const JoinCodeBodySchema = z.strictObject({
  name: z.string().min(1).max(64).optional().describe("A name for the machine's key (default: the hostname it reports when it joins)"),
});
export const JoinBodySchema = z.strictObject({
  code: z.string().min(1).max(200).describe("The one-time join code"),
  machine: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "a hostname: letters, digits, . _ -")
    .describe("The joining machine's hostname"),
});
export const DiscoveryProofBodySchema = DiscoveryClaimSchema.extend({ key: DiscoveryKeyIdSchema.describe("The key id from the worker's query") });
export const ApproveTaskBodySchema = z.object({
  force: z.boolean().optional().describe("Merge even when the pull request's checks are failing, still running or can't be read"),
});
export const RequestChangesBodySchema = z.object({
  message: z.string().trim().min(1).max(MAX_CHANGE_REQUEST_LENGTH).describe("What should change; the agent gets it as written"),
});

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export const VersionSchema = z.object({
  version: z.string().nullable().describe("`0.1.0+<build>` of the package this Hub serves"),
  package: z.boolean(),
  sha256: z.string().nullable(),
});

export const SyncStatusSchema = z.object({
  enabled: z.boolean(),
  remote: z.string(),
  url: z.string().nullable(),
  reason: z.string().optional(),
  state: z.enum(["disabled", "idle", "pushing", "error", "conflict"]),
  lastPushAt: Timestamp.optional(),
  lastPushedCommit: z.string().optional(),
  lastError: z.string().optional(),
});

export const HealthSchema = z.object({
  status: z.literal("ok"),
  auth: z.boolean(),
  /** The rest only with the token. */
  projectsRoot: z.string().nullable().optional(),
  projects: z.array(z.string()).optional(),
  /** Details of the only project, kept for tools from before projects (null with several). */
  targetDir: z.string().nullable().optional(),
  stateDir: z.string().nullable().optional(),
  mainBranch: z.string().nullable().optional(),
  sync: SyncStatusSchema.nullable().optional(),
  qa: z
    .object({ enabled: z.boolean(), command: z.array(z.string()), kind: z.string(), timeoutSec: z.number(), setup: z.array(z.array(z.string())).optional() })
    .nullable()
    .optional(),
  allowDependencies: z.array(z.string()).nullable().optional(),
  connections: z.number().int().optional(),
  uptimeSec: z.number().optional(),
});

export const PullRequestStatusSchema = z.object({
  enabled: z.boolean(),
  repo: z.string().optional().describe("owner/repo on GitHub"),
  reason: z.string().optional().describe("Why work is merged on the Hub instead"),
});

export const DeployStatusSchema = z.object({
  state: z.enum(["running", "succeeded", "failed"]),
  commit: z.string().describe("The main commit being deployed"),
  startedAt: Timestamp,
  finishedAt: Timestamp.optional(),
  error: z.string().optional(),
  output: z.string().optional().describe("The end of the command's output"),
});

export const DeployStartedSchema = z.object({ deploying: z.literal(true) });

export const DeployJobSchema = z.object({
  id: z.string(),
  project: ProjectIdSchema,
  commit: z.string(),
  command: z.object({
    command: z.string(),
    timeoutSec: z.number().int().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
});
export const DeployNextSchema = z.object({ job: DeployJobSchema.nullable().describe("The oldest job nobody has taken, or null") });
export const DeployResultBodySchema = z.strictObject({
  ok: z.boolean(),
  error: z.string().max(2000).optional(),
  output: z.string().max(20_000),
});
export const DeployResultAcceptedSchema = z.object({ accepted: z.literal(true) });

/**
 * The Hub's own update (`aso start-hub --update-from`), as the updater on the Hub machine reports
 * it: `off` without one, `current` when the Hub runs the remote's main, then `building` (and
 * testing) a newer commit, `waiting` for the swarm to be idle, `restarting` onto it, and
 * `updated` or `failed` (a failed build, or a new version that didn't come up and was rolled back).
 */
export const HubUpdateStateSchema = z.enum(["off", "current", "building", "waiting", "restarting", "updated", "failed"]);
export const HubUpdateReportBodySchema = z.strictObject({
  state: HubUpdateStateSchema.exclude(["off"]),
  target: z.string().min(1).max(100).optional().describe("The commit being installed, or the one that failed"),
  error: z.string().max(2000).optional(),
});
export const HubUpdateSchema = z.object({
  state: HubUpdateStateSchema,
  current: z.string().describe("The aso build this Hub runs (its own, whatever was reported)"),
  target: z.string().optional().describe("The commit being installed, or the one that failed"),
  error: z.string().optional(),
  at: z.string().optional().describe("ISO 8601 time the updater reported this state"),
});
export type HubUpdate = z.infer<typeof HubUpdateSchema>;

export const ProjectSchema = z.object({
  id: ProjectIdSchema,
  dir: z.string(),
  mainBranch: z.string(),
  sync: SyncStatusSchema,
  pullRequests: PullRequestStatusSchema,
  tasks: z.object({
    total: z.number().int(),
    running: z.number().int(),
    reviewing: z.number().int(),
    queued: z.number().int(),
    failed: z.number().int(),
    merged: z.number().int(),
  }),
  plansAwaitingApproval: z.number().int(),
  plansWithQuestions: z.number().int(),
  deploy: z.object({
    configured: z.boolean().describe("Whether the operator gave this project a command in the Hub's deploy.json"),
    last: DeployStatusSchema.optional().describe("The latest deploy since the Hub started"),
  }),
});
export type ApiProject = z.infer<typeof ProjectSchema>;
export type ApiDeployStatus = z.infer<typeof DeployStatusSchema>;

const ActionsSchema = z.object({
  drain: z.boolean(),
  resume: z.boolean(),
  restart: z.boolean(),
  why: z.object({ drain: z.string().optional(), resume: z.string().optional(), restart: z.string().optional() }),
});

export const NodeSchema = z.object({
  nodeId: z.string(),
  nodeKind: z.enum(["worker", "architect"]),
  version: z.string(),
  outdated: z.boolean(),
  connectedAt: Timestamp,
  lastSeenAt: Timestamp,
  currentTaskId: z.string().nullable(),
  currentTaskIds: z.array(z.string()),
  jobs: z
    .array(z.object({ taskId: z.string(), job: z.enum(["implement", "test"]), slot: z.number().int().optional().describe("Its desk, once the worker reported it") }))
    .describe("What it runs, and at which desk (the agent named `<host> #<slot>`)"),
  slots: z.number().int(),
  heartbeat: z.object({ memoryAvailableBytes: z.number(), cpuLoadPercent: z.number(), dockerAvailable: z.boolean() }).nullable(),
  draining: z.boolean(),
  restart: z.enum(["pending", "sent"]).nullable(),
  updateTo: z.string().nullable(),
  updateError: z.object({ version: z.string(), reason: z.string() }).nullable(),
  workerKey: z.object({ id: z.string(), name: z.string() }).nullable().describe("The worker key it connected with; null for the Hub's own token"),
  actions: ActionsSchema,
  /** Workers only. */
  hardware: HardwareProfileSchema.optional(),
  supervisor: SupervisorSchema.optional(),
  updates: z.enum(["package"]).optional(),
  /** Sent by workers from before roles were the Architect's call; ignored. */
  roles: z.array(z.string()).optional(),
});
export type ApiNode = z.infer<typeof NodeSchema>;

const ReworkSchema = z
  .object({
    round: z.number().int(),
    reason: z.string(),
    failures: z.array(z.object({ test: z.string().optional(), file: z.string().optional(), message: z.string() })),
    output: z.string().optional(),
  })
  .describe("Why the work came back to an agent, as the agent is told");

const ReviewSchema = z
  .object({
    pr: z.object({ number: z.number().int(), url: z.string() }).optional(),
    error: z.string().optional().describe("Why opening or checking the pull request last failed"),
    rounds: z.number().int().describe("Times a reviewer asked for changes"),
    handled: z.array(z.number().int()),
  })
  .describe("The task's GitHub pull request, with pull requests on");

export const TaskSchema = z.object({
  spec: TaskSpecSchema,
  project: z.string(),
  state: TaskStateSchema,
  nodeId: z.string().optional(),
  qaNodeId: z.string().optional(),
  qaStarted: z.boolean().optional(),
  qaSetup: z.array(z.array(z.string())).optional().describe("Commands run before the tests"),
  detachedAt: z.number().optional().describe("When its worker dropped off (epoch ms); held for it until the grace period ends"),
  attempts: z.number().int(),
  qaAttempts: z.number().int(),
  drops: z.number().int(),
  reworkRound: z.number().int(),
  rework: ReworkSchema.optional(),
  retries: z.number().int().optional(),
  budgetBaseUsd: z.number().optional().describe("Spend before the latest retry; the budget counts from here"),
  commit: z.string().optional(),
  mainCommit: z.string().optional(),
  qaSummary: z.string().optional(),
  screenshots: z
    .object({
      commit: z.string().describe("The commit QA tested when it took them"),
      at: Timestamp,
      files: z.array(z.object({ name: z.string(), mediaType: z.string(), bytes: z.number().int() })),
    })
    .optional()
    .describe("What the project's screenshots script saved in the last passing QA run; GET /api/tasks/{id}/screenshots/{name} serves each"),
  screenshotTargets: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        theme: z.enum(["light", "dark"]).optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        selector: z.string().optional(),
        state: z.string().optional(),
      }),
    )
    .optional()
    .describe("The views the developer agent asked QA to screenshot at its last finish (passed to the screenshots script)"),
  conflicts: z.array(z.string()).optional().describe("Files left with merge conflict markers for the agent to resolve this round"),
  crew: z.array(CrewMemberSchema).optional().describe("The agents that implemented and tested it, oldest first"),
  review: ReviewSchema.optional(),
  llm: UsageSchema,
  filesTouched: z.array(z.string()),
  agentLog: z.array(AgentTurnSchema),
  planId: z.string().optional(),
  waitingReason: z.string().optional().describe("Why a queued task is not running yet"),
  routing: z.object({ nodeId: z.string(), score: z.number(), reasons: z.array(z.string()) }).optional().describe("Why its worker was chosen"),
  detail: z.string().optional(),
  summary: z.string().optional().describe("What the developer agent said it changed and how it checked it, at its last finish"),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  history: HistorySchema,
});

const DialogueEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("questions"), at: Timestamp, questions: z.array(z.string()), context: z.string().optional() }),
  z.object({ kind: z.literal("proposal"), at: Timestamp, summary: z.string(), tasks: z.array(PlannedTaskSchema) }),
  z.object({ kind: z.literal("reply"), at: Timestamp, text: z.string() }),
]);

export const PlanSchema = z.object({
  planId: z.string(),
  project: z.string(),
  requirement: z.string(),
  state: PlanStateSchema,
  architectNodeId: z.string().optional(),
  summary: z.string().optional(),
  tasks: z.array(PlannedTaskSchema).optional(),
  taskIds: z.record(z.string(), z.string()).optional().describe("Plan key → task id, once approved"),
  questions: z.array(z.string()).optional(),
  dialogue: z.array(DialogueEntrySchema).optional(),
  error: z.string().optional(),
  budgetBaseUsd: z.number().optional(),
  llm: UsageSchema,
  agentLog: z.array(AgentTurnSchema),
  history: HistorySchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const CheckStateSchema = z.enum(["passing", "failing", "pending", "skipped"]);
export type CheckState = z.infer<typeof CheckStateSchema>;
export const ChecksOverallSchema = z.enum(["passing", "failing", "pending", "none", "unknown"]);
export type ChecksOverall = z.infer<typeof ChecksOverallSchema>;

export const ReviewChecksSchema = z
  .object({
    pr: z.object({ number: z.number().int(), url: z.string() }),
    headSha: z.string(),
    mergeable: z.boolean().nullable().describe("False when it conflicts with main; null while GitHub is still working it out"),
    overall: ChecksOverallSchema.describe("failing if any check fails, else pending if any runs, else passing; none without checks; unknown when they can't be read"),
    checks: z.array(z.object({ name: z.string(), state: CheckStateSchema, url: z.string().optional() })),
    error: z.string().optional().describe("Why the checks could not be read"),
  })
  .describe("The CI checks on a task's pull request");
export type ReviewChecks = z.infer<typeof ReviewChecksSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted"]),
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
  patch: z.string().optional().describe("The unified diff; left out for binary files and when the answer would get too big"),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;
export const TaskDiffSchema = z
  .object({
    base: z.string().describe("Where the task's branch left main"),
    head: z.string().describe("The task's commit"),
    files: z.array(DiffFileSchema),
    truncated: z.boolean().describe("Some patches were left out to keep the answer small"),
  })
  .describe("What a task changes, against the main it branched from");
export type TaskDiff = z.infer<typeof TaskDiffSchema>;

const EntryBase = { seq: z.number().int(), at: Timestamp };
export const TranscriptSchema = z.object({
  entries: z.array(
    z.discriminatedUnion("kind", [
      z.object({ ...EntryBase, kind: z.literal("text"), text: z.string() }),
      z.object({ ...EntryBase, kind: z.literal("call"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
      z.object({ ...EntryBase, kind: z.literal("result"), id: z.string(), name: z.string().optional(), content: z.string(), isError: z.boolean() }),
      z.object({ ...EntryBase, kind: z.literal("event"), text: z.string() }),
      z.object({ ...EntryBase, kind: z.literal("qa"), outcome: z.enum(["pass", "fail"]), summary: z.string(), output: z.string().optional() }),
    ]),
  ),
  last: z.number().int().describe("Highest seq so far; pass it as `after` to get only newer entries"),
});

export const LlmStatusSchema = z.object({
  configured: z.boolean(),
  adapter: z.string().nullable(),
  model: z.string().nullable().describe("The Architect's model"),
  agentModel: z.string().nullable().describe("The task agents' model (builders, QA)"),
  taskBudgetUsd: z.number(),
  planBudgetUsd: z.number(),
  maxTurns: z.number().int(),
  queue: z.object({ limit: z.number().int(), running: z.number().int(), waiting: z.number().int() }).describe("Model requests at once, now and waiting"),
  conversations: z.number().int(),
  totals: z.object({ calls: z.number().int(), costUsd: z.number() }),
  paused: z
    .object({ reason: z.string(), since: Timestamp })
    .optional()
    .describe("Model calls are on hold (the account ran out of credit); they resume once a call succeeds again"),
});

export const PushStatusSchema = z.object({ publicKey: z.string(), devices: z.number().int() });
export const PushSubscribedSchema = z.object({ subscribed: z.literal(true), devices: z.number().int() });
export const PushCheckSchema = z.object({ subscribed: z.boolean() });
export const PushRemovedSchema = z.object({ removed: z.boolean(), devices: z.number().int() });
export const PushTestResultSchema = z.object({ sent: z.number().int().describe("Devices that took it"), failed: z.array(z.string()) });
export const SignInCodeSchema = z.object({ code: z.string(), expiresAt: Timestamp });
export const JoinCodeSchema = z.object({ code: z.string(), expiresAt: Timestamp });
export const WorkerKeyJoinedSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string().describe("The machine's worker key: shown this once; the Hub keeps only its hash"),
});
export const WorkerKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.optional(),
  revokedAt: Timestamp.optional(),
  connected: z.boolean().describe("Whether a worker is connected with it now"),
});
export const DiscoveryProofSchema = z.object({ proof: z.string().describe("HMAC-SHA256 over the claim, keyed with the credential's secret (hex)") });
export const SignedInSchema = z.object({ ok: z.literal(true) });
