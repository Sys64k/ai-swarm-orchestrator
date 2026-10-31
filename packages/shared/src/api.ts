import { z } from "zod";
import { DiscoveryClaimSchema, DiscoveryKeyIdSchema } from "./discovery.js";
import { MAX_PLAN_REPLY_LENGTH } from "./plan-dialogue.js";
import { HardwareProfileSchema, LlmUsageSchema, PlannedTaskSchema, ProjectIdSchema, SupervisorSchema, TaskLevelSchema, TaskSpecInputSchema, TaskSpecSchema } from "./protocol.js";

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

/** How a build can end (`pushed`: its work is still being checked), and how a QA run can; a job of either can also end `failed`, `dropped` or `cancelled`. */
export const BUILD_RESULTS = ["pushed", "built", "unverified", "failed", "outOfTurns", "modelRefused", "dropped", "cancelled"] as const;
export const QA_RUN_RESULTS = ["passed", "qaFailed", "error"] as const;
export const JOB_RESULTS = [...BUILD_RESULTS, ...QA_RUN_RESULTS] as const;
export type JobResult = (typeof JOB_RESULTS)[number];
/** The ended builds' results a track record counts (every build result but `pushed`). */
export const COUNTED_BUILD_RESULTS = ["built", "unverified", "failed", "outOfTurns", "modelRefused", "dropped", "cancelled"] as const satisfies ReadonlyArray<JobResult>;
export const JOB_RESULT_MEANING: Record<JobResult, string> = {
  pushed: "A build that pushed its work; it is being checked",
  built: "A build whose pushed work checked out",
  unverified: "A build whose push failed the Hub's checks",
  failed: "A job whose agent gave up, or whose task failed during it",
  outOfTurns: "A build whose agent used all its turns, or whose conversation filled its model's context window (its work was kept for the next round)",
  modelRefused: "A build whose model's API refused the request (another model took over)",
  dropped: "A job whose machine went offline before it ended",
  cancelled: "A job ended because its task was cancelled",
  passed: "A QA run whose tests passed",
  qaFailed: "A QA run whose tests failed",
  error: "A QA run that couldn't run the tests at all",
};

/**
 * Why work the acceptance check passed proved wrong later: a person asked for changes on its pull
 * request, closed it without merging, or the deploy of its merge failed in the project's own command.
 */
export const OVERTURN_REASONS = ["changesRequested", "closed", "deployFailed"] as const;
export type OverturnReason = (typeof OVERTURN_REASONS)[number];

export const JobRecordSchema = z
  .object({
    job: z.enum(["implement", "test"]),
    round: z.number().int().describe("The task's rework round the job ran in (0: the first try)"),
    host: z.string().describe("The worker machine's hostname"),
    slot: z.number().int().describe("The job slot (desk) on it, from 1"),
    nodeId: z.string().describe("The worker's node id at the time"),
    model: z.string().optional().describe("The model its agent ran on (builds only)"),
    startedAt: Timestamp,
    endedAt: Timestamp.optional().describe("Absent while it runs"),
    result: z.enum(JOB_RESULTS).optional().describe("How it ended"),
    qa: z.enum(["passed", "failed"]).optional().describe("A build's work in QA"),
    acceptance: z.enum(["met", "unmet", "undecided"]).optional().describe("A build's work in the acceptance check"),
    acceptanceModel: z.string().optional().describe("The model that judged it"),
    acceptanceCostUsd: z.number().optional().describe("What that check cost (estimated)"),
    qualityNotes: z.number().int().optional().describe("Quality notes the check made on its work (they don't block)"),
    writesTests: z.boolean().optional().describe("The test writer's job on a tests-first task, not a build: track records leave it out"),
    overturned: z
      .enum(OVERTURN_REASONS)
      .optional()
      .describe("Work the acceptance check passed (met) that proved wrong later: a person asked for changes, closed its pull request, or the deploy of its merge failed"),
    calls: z.number().int().describe("Model calls its agent made"),
    costUsd: z.number().describe("Their estimated cost"),
  })
  .describe("One job on a task: a build (implementation or rework round) or a QA run, with what came of it");
export type JobRecord = z.infer<typeof JobRecordSchema>;

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
/** What a worker key may do: its projects, whether its machine is trusted, its model budget. */
const ScopeFields = {
  projects: z.array(ProjectIdSchema).max(100).describe("The projects it may clone and work on (default: all)"),
  trusted: z.boolean().describe("A trusted machine also runs QA; an untrusted one only builds, and its work is tested by a trusted one (default: trusted)"),
  budgetUsd: z.number().min(0).max(100_000).describe("USD of model calls its jobs may cause in total (default: no cap beyond task budgets)"),
};
export const JoinCodeBodySchema = z.strictObject({
  name: z.string().min(1).max(64).optional().describe("A name for the machine's key (default: the hostname it reports when it joins)"),
  projects: ScopeFields.projects.optional(),
  trusted: ScopeFields.trusted.optional(),
  budgetUsd: ScopeFields.budgetUsd.optional(),
});
export const WorkerKeyScopeBodySchema = z.strictObject({
  projects: ScopeFields.projects.nullable().optional().describe("The projects it may use; null: all"),
  trusted: ScopeFields.trusted.optional(),
  budgetUsd: ScopeFields.budgetUsd.nullable().optional().describe("Its model budget in USD; null: none"),
});
export const JoinBodySchema = z.strictObject({
  code: z.string().min(1).max(200).describe("The one-time join code"),
  machine: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, "a hostname: letters, digits, . _ -")
    .describe("The joining machine's hostname"),
});
export const DiscoveryProofBodySchema = DiscoveryClaimSchema.extend({ key: DiscoveryKeyIdSchema.describe("The key id from the worker's query") });
/** The model providers ASO knows how to reach; `custom` is any OpenAI-compatible API by address. */
export const PROVIDER_PRESETS = ["anthropic", "openai", "openrouter", "gemini", "groq", "mistral", "ollama", "ollama-cloud", "custom"] as const;
export type ProviderPreset = (typeof PROVIDER_PRESETS)[number];

export interface PresetInfo {
  label: string;
  /** The API's root for cloud providers; `null` when the person gives it (or, for Anthropic, the SDK knows it). */
  baseUrl: string | null;
  kind: "anthropic" | "openai-compatible";
  /** A server on your own network (one GPU): its models get one call at once by default. */
  local: boolean;
  keyRequired: boolean;
  urlRequired: boolean;
  /** The request field for the answer's token limit: OpenAI's reasoning models refuse `max_tokens`. */
  maxTokensField: "max_tokens" | "max_completion_tokens";
}

/** Everything ASO knows about each provider preset; adding a preset means adding a row. */
export const PRESET_INFO: Record<ProviderPreset, PresetInfo> = {
  anthropic: { label: "Anthropic", baseUrl: null, kind: "anthropic", local: false, keyRequired: true, urlRequired: false, maxTokensField: "max_tokens" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", kind: "openai-compatible", local: false, keyRequired: true, urlRequired: false, maxTokensField: "max_completion_tokens" },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", kind: "openai-compatible", local: false, keyRequired: true, urlRequired: false, maxTokensField: "max_tokens" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", kind: "openai-compatible", local: false, keyRequired: true, urlRequired: false, maxTokensField: "max_tokens" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", kind: "openai-compatible", local: false, keyRequired: true, urlRequired: false, maxTokensField: "max_tokens" },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1", kind: "openai-compatible", local: false, keyRequired: true, urlRequired: false, maxTokensField: "max_tokens" },
  ollama: { label: "Ollama", baseUrl: null, kind: "openai-compatible", local: true, keyRequired: false, urlRequired: true, maxTokensField: "max_tokens" },
  "ollama-cloud": { label: "Ollama Cloud", baseUrl: "https://ollama.com/v1", kind: "openai-compatible", local: false, keyRequired: true, urlRequired: false, maxTokensField: "max_tokens" },
  custom: { label: "Custom", baseUrl: null, kind: "openai-compatible", local: true, keyRequired: false, urlRequired: true, maxTokensField: "max_tokens" },
};

export function isProviderPreset(s: string): s is ProviderPreset {
  return Object.hasOwn(PRESET_INFO, s);
}
/** A provider's name on the Hub: what model specs start with (`<provider>/<model>`). */
export const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "lower-case letters, digits, . _ - (up to 40)");
export const ProviderAddBodySchema = z.strictObject({
  preset: z.enum(PROVIDER_PRESETS).describe("Which provider; known ones know their own address"),
  id: ProviderIdSchema.optional().describe("Its name on the Hub (default: the preset's), e.g. ollama-avalon for a second Ollama"),
  key: z.string().min(1).max(500).optional().describe("The API key; stored on the Hub, never shown again"),
  baseUrl: z.string().url().max(500).optional().describe("The API's root, for ollama and custom (e.g. http://avalon:11434/v1)"),
  vision: z.boolean().optional().describe("Its models accept images (OpenAI-compatible)"),
}).superRefine((body, ctx) => {
  const info = PRESET_INFO[body.preset];
  if (info.keyRequired && !body.key) ctx.addIssue({ code: "custom", path: ["key"], message: `${info.label} needs an API key` });
  if (info.urlRequired && !body.baseUrl) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: `${info.label} needs the server's address, e.g. http://avalon:11434/v1` });
});
export type ProviderAddBody = z.infer<typeof ProviderAddBodySchema>;
export const ProviderViewSchema = z.object({
  id: z.string(),
  preset: z.enum(PROVIDER_PRESETS),
  kind: z.enum(["anthropic", "openai-compatible"]),
  label: z.string(),
  source: z.enum(["added", "environment"]).describe("environment: from the Hub's .env (ANTHROPIC_API_KEY, ASO_LLM_BASE_URL); remove it there"),
  hasKey: z.boolean().describe("Whether it has a key (the key itself is never shown)"),
  baseUrl: z.string().optional(),
  vision: z.boolean().optional(),
  models: z.number().int().optional().describe("Models in its list"),
  error: z.string().optional().describe("Why its model list couldn't be fetched"),
});
export type ProviderView = z.infer<typeof ProviderViewSchema>;
export const ProviderRemovedSchema = z.object({ removed: z.string().describe("The provider removed; its key is forgotten") });

/** USD per million tokens; cache reads and writes are charged at the input rate for prices set here. */
export const PriceSetBodySchema = z.strictObject({
  model: z.string().min(1).max(200).describe("The model: <provider>/<model> or its name; the price applies to that model name"),
  input: z.number().min(0).max(10_000).describe("USD per million input tokens"),
  output: z.number().min(0).max(10_000).describe("USD per million output tokens"),
  cacheRead: z.number().min(0).max(10_000).optional().describe("USD per million cached input tokens read (default: the input price)"),
  cacheWrite: z.number().min(0).max(10_000).optional().describe("USD per million input tokens written to the cache (default: the input price)"),
});
export const PriceRemoveBodySchema = z.strictObject({ model: z.string().min(1).max(200) });
export const PriceSchema = z.object({
  model: z.string(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().describe("Cached input tokens read"),
  cacheWrite: z.number().describe("Input tokens written to the cache"),
  source: z.enum(["built-in", "set"]).describe("set: a price set on this Hub (it wins over the built-in one)"),
});
export const PricesSchema = z.array(PriceSchema);
export type PriceEntry = z.infer<typeof PriceSchema>;

/** A desk: a worker machine's hostname and job slot, e.g. `avalon#1` (the Hub's `deskName` builds these). */
export const DeskSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}#[1-9][0-9]?$/, "<hostname>#<slot>, e.g. avalon#1");
/** Optional settings for one model desks use; everything has a default. */
export const DeskModelSettingsSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(64).optional().describe("Calls at once (default: 1 for local/OpenAI-compatible models, the Hub's --llm-concurrency for Claude)"),
  baseUrl: z.string().url().max(500).optional().describe("For a model on another OpenAI-compatible server than the Hub's ASO_LLM_BASE_URL"),
  vision: z.boolean().optional().describe("For OpenAI-compatible models, whether the model accepts images"),
});
/** The model roles besides the desks: who plans, and who judges work in the acceptance check. */
export const MODEL_ROLES = ["architect", "reviewer"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/** The roles a challenger model can be tried in: the desks' builders and the reviewer. */
export const CHALLENGER_ROLES = ["desks", "reviewer"] as const;
export type ChallengerRole = (typeof CHALLENGER_ROLES)[number];
/** The share of tasks a challenger takes unless told otherwise, and the most it may take. */
export const DEFAULT_CHALLENGER_SHARE = 0.1;
export const MAX_CHALLENGER_SHARE = 0.5;
/**
 * What a trial may spend unless told otherwise (USD): enough for the samples it needs. A desks
 * trial pays for whole tasks (about $1–2 each, all in, for 10), the reviewer's only for checks.
 */
export const DEFAULT_CHALLENGER_BUDGET_USD: Record<ChallengerRole, number> = { desks: 20, reviewer: 5 };

export const ChallengerBodySchema = z.strictObject({
  role: z.enum(CHALLENGER_ROLES).describe("desks: tasks start on it; reviewer: it makes their acceptance checks"),
  model: z.string().min(1).max(200).describe("A model from GET /api/models (<provider>/<model>), or none to end the trial"),
  share: z.number().min(0.01).max(MAX_CHALLENGER_SHARE).optional().describe("The share of tasks it takes (default 0.1)"),
  budgetUsd: z.number().min(0.5).max(1000).optional().describe("What the trial may spend in all (default 20 for the desks, 5 for the reviewer)"),
  end: z.literal(true).optional().describe("End this model's trial (model none ends every one in the role)"),
});

export const TuningBodySchema = z
  .strictObject({
    role: z.enum(CHALLENGER_ROLES),
    auto: z.boolean().optional().describe("Let the Hub try the queued candidates and move the shares by itself"),
    candidates: z.array(z.string().min(1).max(200)).max(5).optional().describe("Models to try, in order (from GET /api/models); [] clears the queue"),
  })
  .refine((b) => b.auto !== undefined || b.candidates !== undefined, "give auto, candidates or both");

/** A trial, as `GET /api/desks` shows it. */
export const TrialSchema = z.object({
  model: z.string(),
  share: z.number(),
  budgetUsd: z.number(),
  since: z.string().describe("When the trial began"),
  samples: z.number().int().describe("Settled tasks it started (desks) or met verdicts it gave (reviewer) since then"),
  needed: z.number().int().describe("How many suggestions need to compare it"),
  spentUsd: z.number(),
  ended: z.enum(["enough data", "budget spent"]).optional().describe("Why it takes no more tasks"),
});
export type Trial = z.infer<typeof TrialSchema>;

/** A role's model pool, as `GET /api/tuning` shows it. */
export const RolePoolSchema = z.object({
  base: z.string().nullable().describe("The role's own model: it takes the work the members don't"),
  baseShare: z.number().describe("The share of the work the base takes"),
  members: z.array(TrialSchema).describe("Models with a share of the work, and how each stands"),
  auto: z.boolean().describe("Whether the Hub tries the candidates and moves the shares by itself"),
  candidates: z.array(z.string()).describe("Models queued to try, in order"),
});
export const TuningViewSchema = z.object({
  roles: z.object({ desks: RolePoolSchema, reviewer: RolePoolSchema }),
  log: z.array(z.object({ at: z.string(), role: z.enum(CHALLENGER_ROLES), text: z.string() })).describe("What auto-tuning changed, oldest first"),
});
export type TuningView = z.infer<typeof TuningViewSchema>;

export const RoleModelBodySchema = DeskModelSettingsSchema.extend({
  role: z.enum(MODEL_ROLES).describe("architect: who plans; reviewer: who judges work in the acceptance check"),
  model: z.string().min(1).max(200).describe("A model from GET /api/models (<provider>/<model>), or default: the Hub's --model (the reviewer's default is the Architect's model)"),
});
/** Most models a task can escalate through, weakest first. */
export const MAX_ESCALATION_LADDER = 5;
/** Most tries a task gets on its desk's model before it escalates. */
export const MAX_JUNIOR_TRIES = 100;
export const EscalationBodySchema = z
  .strictObject({
    ladder: z
      .union([z.array(z.string().min(1).max(200)).min(1).max(MAX_ESCALATION_LADDER), z.literal("default")])
      .optional()
      .describe("Stronger models a failing task moves to, weakest first (from GET /api/models), or default: the Hub's --escalate-to, else its --model"),
    juniorTries: z
      .union([z.number().int().min(0).max(MAX_JUNIOR_TRIES), z.literal("default")])
      .optional()
      .describe("Tries on the desk's model before a task escalates, counting the first attempt (0: straight to the ladder), or default: the Hub's --junior-tries"),
  })
  .refine((b) => b.ladder !== undefined || b.juniorTries !== undefined, "give ladder, juniorTries or both");
export const DeskAssignmentBodySchema = DeskModelSettingsSchema.extend({
  target: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(#[1-9][0-9]?)?$/, "a desk (<hostname>#<slot>) or a machine (<hostname>, all its desks)")
    .describe("A desk, e.g. avalon#4, or a connected machine, e.g. avalon, for all its desks"),
  model: z.string().min(1).max(200).describe("A model from GET /api/models (e.g. claude-haiku-5-5, qwen3-coder:30b), openai:<name>, or default"),
});
export const ApproveTaskBodySchema = z.object({
  force: z.boolean().optional().describe("Merge even when the pull request's checks are failing, still running or can't be read"),
});
export const RetryTaskBodySchema = z
  .object({
    description: z.string().trim().min(1).max(20_000).optional().describe("The task's new description"),
    acceptanceCriteria: z.array(z.string().trim().min(1)).max(20).optional().describe("The task's new acceptance criteria, replacing the old ones"),
  })
  .describe("Correct the task before it runs again, e.g. a criterion that can't be met; the agent is told what changed");
export type RetryTaskBody = z.infer<typeof RetryTaskBodySchema>;
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
  storage: z
    .enum(["postgres", "files", "memory"])
    .optional()
    .describe("Where tasks, plans and conversations are kept: a PostgreSQL database, state files, or memory only"),
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
  exitCode: z.number().int().optional().describe("When the command ran to its end and failed: its exit code"),
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
  exitCode: z.number().int().optional().describe("When the command ran to its end and failed: its exit code"),
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
    failed: z.number().int().describe("Failed tasks that still need someone: not dismissed, not superseded"),
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
  localModels: z.array(z.object({ id: z.string(), vision: z.boolean().optional() })).optional().describe("Models this machine serves itself, for its own jobs (machine/<model>)"),
  defaultLocalModel: z.string().optional().describe("The one its desks use unless put on another model"),
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

/** What the acceptance check notes about a change's quality besides its criteria; notes never block. */
export const QUALITY_NOTE_KINDS = ["duplication", "dead-code", "misleading-summary", "tests-weakened", "other"] as const;
export type QualityNoteKind = (typeof QUALITY_NOTE_KINDS)[number];
export const QUALITY_NOTE_LABEL: Record<QualityNoteKind, string> = {
  duplication: "Duplicated code",
  "dead-code": "Dead code",
  "misleading-summary": "Summary doesn't match the diff",
  "tests-weakened": "Existing tests weakened or removed",
  other: "Other",
};
/** Most notes kept from one check. */
export const MAX_QUALITY_NOTES = 5;
/** Quality notes that send the work back like an unmet criterion; the others never block. */
export const BLOCKING_QUALITY_NOTES: readonly QualityNoteKind[] = ["tests-weakened"];
export const isBlockingNote = (note: Pick<QualityNote, "kind">): boolean => BLOCKING_QUALITY_NOTES.includes(note.kind);

export const QualityNoteSchema = z.object({
  kind: z.enum(QUALITY_NOTE_KINDS),
  note: z.string().describe("What it is, in a sentence"),
  file: z.string().optional(),
});
export type QualityNote = z.infer<typeof QualityNoteSchema>;

export const TestsFirstSchema = z
  .object({
    phase: z.enum(["tests", "build"]).describe("tests: the test writer (the Architect's model) writes them; build: the builder makes them pass"),
    commit: z.string().optional().describe("The test writer's last commit"),
    files: z.array(z.string()).describe("The tests it wrote: a builder's push that changes them is refused"),
    notes: z.string().optional().describe("The test writer's summary, for the builder"),
    disputed: z.boolean().optional().describe("The builder said a test was wrong, and the tests went back to their writer (once)"),
    from: z.string().optional().describe("After a dispute: the branch head the test writer started from; only its own changes since are checked and locked"),
  })
  .describe("A tests-first task's phases");
export type TestsFirst = z.infer<typeof TestsFirstSchema>;

export const AcceptanceSchema = z
  .object({
    result: z.enum(["checking", "met", "unmet", "undecided"]).describe("checking: under way; undecided: the check couldn't tell, and the work went on"),
    commit: z.string().describe("The commit it checked"),
    at: Timestamp,
    model: z.string().optional(),
    summary: z.string().optional(),
    reason: z.string().optional().describe("Why it was undecided"),
    criteria: z
      .array(z.object({ criterion: z.string(), verdict: z.enum(["met", "unmet", "unclear"]), reason: z.string() }))
      .optional(),
    qualityNotes: z.array(QualityNoteSchema).optional().describe("Quality issues it saw besides the criteria; they never block"),
  })
  .describe("The check of the work against the task's acceptance criteria, after QA passed");
export type Acceptance = z.infer<typeof AcceptanceSchema>;
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
  autoMerge: z.boolean().optional().describe("Its pull request is merged without a person once QA passed, every acceptance criterion is met and CI passes (API syncs)"),
  supersededBy: z.string().optional().describe("A newer task that does this one's job (a newer sync of the API copy); this one can't be retried"),
  dismissedAt: Timestamp.optional().describe("When a person dismissed this failed or cancelled task: it no longer needs anyone; a retry brings it back"),
  diffBase: z.string().optional().describe("A commit the Hub made on the branch first (a sync task's API copy): the acceptance check judges what came after it"),
  refusedModels: z.array(z.string()).optional().describe("Models whose API refused this task's requests; its later rounds use others"),
  outOfTurns: z.boolean().optional().describe("The current attempt's agent used all its turns: its failure becomes a rework round continuing from the saved work"),
  contextFull: z.boolean().optional().describe("The current attempt's conversation filled its model's context window: the same, in a fresh conversation"),
  switchingModel: z.boolean().optional().describe("The current attempt's model was refused: its failure requeues the task on another model"),
  budgetBaseUsd: z.number().optional().describe("Spend before the latest retry; the budget counts from here"),
  commit: z.string().optional(),
  mainCommit: z.string().optional(),
  qaSummary: z.string().optional(),
  acceptance: AcceptanceSchema.optional(),
  testsFirst: TestsFirstSchema.optional(),
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
  jobs: z.array(JobRecordSchema).optional().describe("Every job on it, oldest first: kept since track records began, for them"),
  review: ReviewSchema.optional(),
  llm: UsageSchema,
  filesTouched: z.array(z.string()),
  agentLog: z.array(AgentTurnSchema),
  planId: z.string().optional(),
  challenger: z.string().optional().describe("The model on trial it started on (aso challenger), instead of its desk's"),
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
  model: z.string().optional().describe("The model the Architect planned it on (its latest round's)"),
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
  totals: z
    .object({
      calls: z.number().int(),
      costUsd: z.number(),
      since: z.string().optional().describe("When counting began: kept across restarts when the Hub saves its state, else since it started"),
      today: z
        .object({ date: z.string().describe("The UTC day, YYYY-MM-DD"), costUsd: z.number() })
        .optional()
        .describe("The estimated cost of the day's model calls so far (UTC): what the daily spending notice goes by"),
    })
    .describe("Model calls and their estimated cost, all tasks and plans together"),
  paused: z
    .object({ reason: z.string(), since: Timestamp })
    .optional()
    .describe("Deprecated: use pausedProviders. The oldest hold there, for clients that show one"),
  pausedProviders: z
    .array(
      z.object({
        provider: z.string().describe("The account on hold: \"Anthropic\", or a provider's label"),
        reason: z.string(),
        since: Timestamp,
        until: Timestamp.optional().describe("When the provider says access comes back, if it says"),
      }),
    )
    .optional()
    .describe("Providers whose calls are on hold; the others' go on. Each resumes once one of its calls works again"),
});

export const PushStatusSchema = z.object({ publicKey: z.string(), devices: z.number().int() });
export const PushSubscribedSchema = z.object({ subscribed: z.literal(true), devices: z.number().int() });
export const PushCheckSchema = z.object({ subscribed: z.boolean() });
export const PushRemovedSchema = z.object({ removed: z.boolean(), devices: z.number().int() });
export const PushTestResultSchema = z.object({ sent: z.number().int().describe("Devices that took it"), failed: z.array(z.string()) });

/**
 * Something the Hub tells you about: a plan to approve, a task that failed or keeps coming back,
 * a provider on hold, a worker gone, a failed update, the day's spending. Each one is also pushed
 * to the devices that turned notifications on; the Hub keeps the latest (`GET /api/notices`).
 */
export const NoticeSchema = z.object({
  id: z.string(),
  at: Timestamp,
  title: z.string(),
  body: z.string(),
  url: z.string().describe("The console page it is about (always starts with a single /)"),
  tag: z.string().describe("What it is about (a task, plan, provider, machine…): a newer notice with the same tag replaces it on a phone"),
});
export type Notice = z.infer<typeof NoticeSchema>;
export const NoticesSchema = z.object({
  notices: z.array(NoticeSchema).describe("Newest first"),
  unread: z.number().int().describe("Notices since a person last marked them read"),
});
export type Notices = z.infer<typeof NoticesSchema>;
export const NoticesReadBodySchema = z.strictObject({
  upTo: z.string().min(1).max(100).optional().describe("The id of the newest notice to mark read, with all before it (default: all of them)"),
});
export const SignInCodeSchema = z.object({ code: z.string(), expiresAt: Timestamp });
export const JoinCodeSchema = z.object({
  code: z.string(),
  expiresAt: Timestamp,
  gatewayUrl: z.string().optional().describe("The worker gateway's public wss:// address, when the Hub has one (--gateway-url): for machines joining from the internet"),
});
export const WorkerKeyJoinedSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string().describe("The machine's worker key: shown this once; the Hub keeps only its hash"),
});
/** What a machine's track record counts (each a number of times). */
export const JOB_OUTCOMES = ["built", "qaPassed", "qaFailed", "accepted", "unmet", "failed", "dropped", "tested"] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export const JOB_OUTCOME_MEANING: Record<JobOutcome, string> = {
  built: "It pushed finished work that checked out",
  qaPassed: "QA passed that work",
  qaFailed: "QA failed that work",
  accepted: "The acceptance check found that work met its criteria",
  unmet: "It found criteria unmet",
  failed: "Its agent gave up on a job",
  dropped: "It went offline in the middle of a job",
  tested: "It ran QA on someone's work",
};
export const WorkerKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.optional(),
  revokedAt: Timestamp.optional(),
  projects: z.array(z.string()).optional().describe("The projects it may use; absent: all"),
  trusted: z.boolean().describe("Its machine runs QA too; an untrusted one only builds"),
  budgetUsd: z.number().optional().describe("USD of model calls its jobs may cause in total"),
  spentUsd: z.number().describe("USD its jobs have caused so far (estimated)"),
  track: z
    .object(Object.fromEntries(JOB_OUTCOMES.map((o) => [o, z.number().int().optional().describe(JOB_OUTCOME_MEANING[o])])) as Record<JobOutcome, z.ZodOptional<z.ZodNumber>>)
    .describe("Its machine's track record: what became of the jobs it took"),
  connected: z.boolean().describe("Whether a worker is connected with it now"),
});
export const DiscoveryProofSchema = z.object({ proof: z.string().describe("HMAC-SHA256 over the claim, keyed with the credential's secret (hex)") });
export const AvailableModelSchema = z.object({
  model: z.string().describe("The name to choose it by"),
  spec: z.string().describe("How the Hub calls it: <provider>/<model>"),
  provider: z.enum(["anthropic", "openai-compatible"]).describe("The kind of API"),
  providerId: z.string().optional().describe("The provider on the Hub that offers it"),
  providerLabel: z.string().optional().describe("The provider's name to show, e.g. OpenAI or Ollama (avalon:11434)"),
  baseUrl: z.string().optional().describe("The OpenAI-compatible server it runs on"),
});
export type AvailableModel = z.infer<typeof AvailableModelSchema>;
export const ModelsSchema = z.object({
  architect: z.string().nullable().describe("The Architect's model"),
  reviewer: z.string().nullable().describe("The acceptance check's model (the Architect's unless put on another)"),
  defaultAgent: z.string().nullable().describe("The model of desks without one of their own"),
  available: z.array(AvailableModelSchema).describe("The models desks can use"),
  localError: z.string().optional().describe("Why the local models couldn't be listed"),
});
export type Models = z.infer<typeof ModelsSchema>;
export const DesksSchema = z.object({
  architect: z.string().nullable().describe("The model the Architect plans on"),
  reviewer: z.string().nullable().describe("The model that judges work in the acceptance check (the Architect's unless put on another)"),
  roles: z
    .object({ architect: z.string().optional(), reviewer: z.string().optional() })
    .describe("The roles put on a model of their own (absent: on the default)"),
  escalation: z
    .object({ ladder: z.array(z.string()), juniorTries: z.number().int() })
    .nullable()
    .describe("Where a failing task moves: after juniorTries tries on its desk's model, up the ladder (weakest first); null: escalation is off"),
  escalationSet: z
    .object({ ladder: z.array(z.string()).optional(), juniorTries: z.number().int().optional() })
    .describe("What was changed while the Hub runs (absent: the Hub's start settings)"),
  challengers: z
    .object({ desks: TrialSchema.optional(), reviewer: TrialSchema.optional() })
    .optional()
    .describe("The first model on trial in each role (GET /api/tuning shows all of them)"),
  defaultAgent: z.string().nullable(),
  desks: z.array(z.object({ desk: DeskSchema, model: z.string() })).describe("Desks with a model of their own; the others use the default"),
  models: z
    .array(z.object({ model: z.string(), baseUrl: z.string().optional(), concurrency: z.number().int(), running: z.number().int(), waiting: z.number().int() }))
    .describe("Each model desks use, with its calls at once and how busy it is"),
});
export type Desks = z.infer<typeof DesksSchema>;
export const SignedInSchema = z.object({ ok: z.literal(true) });

export const TRACK_RECORD_KEYS = ["model", "host", "desk", "role", "project", "level"] as const;
export type TrackRecordKey = (typeof TRACK_RECORD_KEYS)[number];

/** The roles model suggestions compare: the desks' builders, the reviewer (acceptance check), the Architect. */
export const SUGGESTION_ROLES = ["desks", "reviewer", "architect"] as const;
export type SuggestionRole = (typeof SUGGESTION_ROLES)[number];
export const SUGGESTION_ROLE_LABEL: Record<SuggestionRole, string> = { desks: "Desks", reviewer: "Reviewer", architect: "Architect" };

/** How a model has done in a role, as suggestions compare it. */
export const SuggestionEvidenceSchema = z.object({
  model: z.string().describe("The model's name, as track records show it"),
  samples: z.number().int().describe("Settled tasks it started (desks), met verdicts (reviewer) or proposed plans (Architect)"),
  quality: z.number().describe("0 to 1: tasks finished of those settled; met verdicts that held up; proposed plans approved"),
  unitCostUsd: z.number().describe("All-in cost per finished task (desks), per check (reviewer) or per plan (Architect)"),
});
export type SuggestionEvidence = z.infer<typeof SuggestionEvidenceSchema>;

export const ModelSuggestionSchema = z.object({
  role: z.enum(SUGGESTION_ROLES),
  kind: z.enum(["cheaper", "better"]).describe("cheaper: as good, for less; better: clearly better, maybe for more"),
  current: SuggestionEvidenceSchema,
  suggested: SuggestionEvidenceSchema,
  spec: z.string().optional().describe("How to choose the suggested model (<provider>/<model>); absent when no provider offers it now"),
  apply: z
    .array(z.object({ kind: z.enum(["desk", "role"]), target: z.string(), model: z.string() }))
    .describe("What applies it, as `aso desk <target> <model>` does: each connected machine (desk) or the role; empty when no provider offers the model now"),
  reason: z.string().describe("The comparison in a sentence"),
});
export type ModelSuggestion = z.infer<typeof ModelSuggestionSchema>;

export const ModelSuggestionsQuerySchema = z.object({
  since: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "a date or time, e.g. 2026-10-01 or 2026-10-01T12:00:00Z")
    .optional()
    .describe("Compare jobs started at or after this (default: the last 30 days)"),
});

export const ModelSuggestionsSchema = z.object({
  since: z.string().describe("The start of the period compared"),
  suggestions: z.array(ModelSuggestionSchema),
  notes: z.array(z.object({ role: z.enum(SUGGESTION_ROLES), text: z.string() })).describe("Why a role has no suggestion: what's missing"),
});
export type ModelSuggestions = z.infer<typeof ModelSuggestionsSchema>;

export const TrackRecordQuerySchema = z.object({
  by: z.enum(TRACK_RECORD_KEYS).default("model").describe("Group by the model, the machine, the desk (machine #slot), the task's role, its project, or its level (how hard, 1 to 5)"),
  project: z.string().optional().describe("Only this project's tasks"),
  role: z.string().optional().describe("Only tasks of this role"),
  level: z.coerce.number().pipe(TaskLevelSchema).optional().describe("Only tasks of this level (how hard, 1 to 5); plans, which have no level, are left out"),
  model: z
    .string()
    .optional()
    .describe("Only this model's work, by its name as the records keep it (e.g. gemini-3.8-flash): its builds and the tasks it started and finished, its plans and acceptance checks; no QA runs, which have no model"),
  since: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "a date or time, e.g. 2026-10-01 or 2026-10-01T12:00:00Z")
    .optional()
    .describe("Only jobs started at or after this date or time"),
  until: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "a date or time, e.g. 2026-10-08 or 2026-10-08T12:00:00Z")
    .optional()
    .describe("Only jobs started before this date or time: with since, one period of a trend (e.g. a week)"),
});
export type TrackRecordQuery = z.infer<typeof TrackRecordQuerySchema>;

export const TrackRecordRowSchema = z
  .object({
    key: z.string().describe("The model, machine, desk, role, project or level (level 1 … level 5, no level)"),
    builds: z
      .object({
        jobs: z.number().int().describe("Builds that ended"),
        built: z.number().int().describe(JOB_RESULT_MEANING.built),
        unverified: z.number().int().describe(JOB_RESULT_MEANING.unverified),
        failed: z.number().int().describe(JOB_RESULT_MEANING.failed),
        outOfTurns: z.number().int().describe(JOB_RESULT_MEANING.outOfTurns),
        modelRefused: z.number().int().describe(JOB_RESULT_MEANING.modelRefused),
        dropped: z.number().int().describe(JOB_RESULT_MEANING.dropped),
        cancelled: z.number().int().describe(JOB_RESULT_MEANING.cancelled),
        qaPassed: z.number().int().describe("Builds whose work passed QA"),
        qaFailed: z.number().int().describe("Builds whose work failed QA"),
        accepted: z.number().int().describe("Builds whose work met every acceptance criterion"),
        unmet: z.number().int().describe("Builds whose work had criteria unmet"),
        qualityNotes: z.number().int().describe("Quality notes the acceptance check made on its builds' work (they don't block)"),
      })
      .describe("Its builds and what came of them"),
    qaRuns: z
      .object({ runs: z.number().int(), passed: z.number().int(), failed: z.number().int(), errors: z.number().int(), dropped: z.number().int() })
      .describe("Its QA runs on others' work (not counted by model: tests run without one)"),
    tasks: z
      .object({
        worked: z.number().int().describe("Tasks it built on"),
        finished: z.number().int().describe("Merged tasks whose last build was its"),
        firstTry: z.number().int().describe("Of those, merged after a single build"),
        tookOver: z.number().int().describe("Of those, tasks someone else built on before it"),
      })
      .describe("The tasks it worked on"),
    costUsd: z.number().describe("Estimated model cost of its builds"),
    costPerFinishedUsd: z.number().optional().describe("costUsd divided by tasks finished: its own builds only (see started for a task's whole cost)"),
    started: z
      .object({
        settled: z.number().int().describe("Merged or failed tasks whose first build was its (cancelled ones aren't counted)"),
        finished: z.number().int().describe("Of those, merged"),
        costUsd: z
          .number()
          .describe("Everything those tasks cost: every build on any model (escalations too), their acceptance checks, and an equal share of their plan"),
        costPerFinishedUsd: z.number().optional().describe("costUsd divided by finished: what a finished task costs when it starts here, failures included"),
      })
      .describe("The tasks that started here, with their whole cost: for choosing a desk's model by cost (absent from Hubs before it)"),
    plans: z
      .object({
        planned: z.number().int().describe("Plans the Architect worked on with it"),
        proposed: z.number().int().describe("Of those, plans that reached a proposal"),
        approved: z.number().int(),
        rejected: z.number().int(),
        failed: z.number().int(),
        withQuestions: z.number().int().describe("Plans where the Architect asked questions first"),
        costUsd: z.number().describe("Their estimated model cost"),
      })
      .describe("Plans made with it (by model and project only)"),
    reviews: z
      .object({
        checks: z.number().int().describe("Acceptance checks it made"),
        met: z.number().int(),
        overturned: z
          .number()
          .int()
          .describe("Of the met, those proved wrong later (a job record's overturned)"),
        unmet: z.number().int(),
        undecided: z.number().int(),
        costUsd: z.number().describe("Their estimated model cost"),
      })
      .describe("Acceptance checks it made on builds' work (by model and project only)"),
  })
  .describe("One model's, machine's, desk's, role's or project's track record");
export type TrackRecordRow = z.infer<typeof TrackRecordRowSchema>;

export const TrackRecordsSchema = z
  .object({
    by: z.enum(TRACK_RECORD_KEYS),
    since: z.string().nullable().describe("When the oldest job counted started (jobs are recorded from when track records began)"),
    rows: z.array(TrackRecordRowSchema).describe("Most tasks finished first"),
  })
  .describe("Track records: how models, machines, desks, roles or projects have done with their jobs");
export type TrackRecords = z.infer<typeof TrackRecordsSchema>;

export const PUBLIC_STATS_PARTS = ["models", "costs"] as const;
export type PublicStatsPart = (typeof PUBLIC_STATS_PARTS)[number];
/** `--public-stats totals`: the totals only, no part. */
export const PUBLIC_STATS_TOTALS = "totals";

/** What a Hub shares publicly: the parts beyond the totals, and whose work (all projects when absent). */
export interface PublicStatsShare {
  parts: readonly PublicStatsPart[];
  projects?: readonly string[];
}

/**
 * `--public-stats totals|models,costs` (and `--public-stats-projects a,b`) → what to share;
 * undefined: nothing. Throws on an unknown part.
 */
export function parsePublicStats(value: string | undefined, projects: string | undefined): PublicStatsShare | undefined {
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const parts = list(value);
  if (!parts.length) return undefined;
  const unknown = parts.filter((p) => p !== PUBLIC_STATS_TOTALS && !(PUBLIC_STATS_PARTS as readonly string[]).includes(p));
  if (unknown.length) throw new Error(`--public-stats: unknown ${unknown.join(", ")} (use ${PUBLIC_STATS_TOTALS}, or any of ${PUBLIC_STATS_PARTS.join(", ")})`);
  const only = list(projects);
  return { parts: parts.filter((p): p is PublicStatsPart => p !== PUBLIC_STATS_TOTALS), ...(only.length ? { projects: only } : {}) };
}

export const PublicStatsSchema = z
  .object({
    since: z.string().nullable().describe("When the oldest job counted started"),
    at: Timestamp.describe("When these numbers were made"),
    tasks: z.object({
      finished: z.number().int().describe("Merged tasks"),
      firstTry: z.number().int().describe("Of those, merged after a single build"),
      tookOver: z.number().int().describe("Of those, finished by a model that took over from another"),
    }),
    plans: z.object({ proposed: z.number().int(), approved: z.number().int() }),
    costs: z
      .object({
        totalUsd: z.number().describe("Estimated model cost of the builds, plans and acceptance checks counted"),
        perTaskUsd: z.number().optional().describe("That per task finished"),
      })
      .optional()
      .describe("Only when the Hub shares costs"),
    models: z
      .array(
        z.object({
          model: z.string(),
          finished: z.number().int(),
          firstTry: z.number().int(),
          tookOver: z.number().int(),
          builds: z.number().int(),
          qaPassed: z.number().int(),
          qaFailed: z.number().int(),
          accepted: z.number().int(),
          unmet: z.number().int(),
          plansProposed: z.number().int(),
          plansApproved: z.number().int(),
          checks: z.number().int().describe("Acceptance checks it made as the reviewer"),
          checksMet: z.number().int(),
          checksOverturned: z.number().int().optional().describe("Of its met checks, those proved wrong later (absent from Hubs before it)"),
          costUsd: z.number().optional().describe("Its builds, plans and checks (only when the Hub shares costs)"),
          costPerTaskUsd: z.number().optional().describe("What a finished task costs when it starts on this model, all in: every build on any model, acceptance checks, its share of its plan, and failed tasks (only when the Hub shares costs)"),
        }),
      )
      .optional()
      .describe("Per model, only when the Hub shares models"),
  })
  .describe("The swarm's track record as the Hub shares it publicly: totals, and per model and costs if it chose to; never machines, people or task titles");
export type PublicStats = z.infer<typeof PublicStatsSchema>;
