import type { WorkerAction } from "./hub-routes.ts";

/**
 * The parts of the Hub's API responses the console uses, copied rather than imported: the console
 * is built and served on its own, without the shared package. Keep them in step with
 * `shared/src/api.ts` (the OpenAPI description, `docs/openapi.json`, is the contract).
 */

export type TaskState =
  | "pending"
  | "assigned"
  | "in_progress"
  | "verifying"
  | "awaiting_qa"
  | "testing"
  | "merging"
  | "awaiting_review"
  | "merged"
  | "failed"
  | "cancelled";

export type PlanState = "pending" | "planning" | "awaiting_input" | "proposed" | "approved" | "rejected" | "failed";

/** The back-and-forth between the Architect and the person, oldest first (mirrors the Hub). */
export type PlanDialogueEntry =
  | { kind: "questions"; at: string; questions: string[]; context?: string }
  | { kind: "proposal"; at: string; summary: string; tasks: PlannedTask[] }
  | { kind: "reply"; at: string; text: string };

export interface HistoryEntry {
  at: string;
  event: string;
}

export interface Task {
  /** The project (folder in the Hub's projects root) the task belongs to. */
  project: string;
  /** A newer task that does this one's job; this one can't be retried. */
  supersededBy?: string;
  spec: {
    taskId: string;
    role: string;
    kind: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    dependsOn: string[];
  };
  state: TaskState;
  planId?: string;
  nodeId?: string;
  qaNodeId?: string;
  detachedAt?: number;
  reworkRound: number;
  retries?: number;
  llm: { calls: number; costUsd: number };
  filesTouched: string[];
  commit?: string;
  mainCommit?: string;
  /** What the project's screenshots script saved in the last passing QA run. */
  screenshots?: { commit: string; at: string; files: Array<{ name: string; mediaType: string; bytes: number }> };
  /** The agents (machine and desk) that implemented and tested it, oldest first. */
  crew?: Array<{ job: "implement" | "test"; host: string; slot: number; nodeId: string; at: string }>;
  /** The task's pull request on GitHub (Hubs with pull requests on). */
  review?: { pr?: { number: number; url: string }; error?: string; rounds: number };
  waitingReason?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
}

export interface PlannedTask {
  key: string;
  role: string;
  kind: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
}

export interface Plan {
  planId: string;
  project: string;
  requirement: string;
  state: PlanState;
  summary?: string;
  tasks?: PlannedTask[];
  taskIds?: Record<string, string>;
  /** Open questions while `awaiting_input`. */
  questions?: string[];
  dialogue?: PlanDialogueEntry[];
  error?: string;
  llm: { calls: number; costUsd: number };
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
}

export interface HubNode {
  nodeId: string;
  nodeKind: "worker" | "architect";
  /** Models this machine serves itself, for its own jobs (absent: none, or an older Hub). */
  localModels?: Array<{ id: string; vision?: boolean }>;
  /** The one its desks use unless put on another model. */
  defaultLocalModel?: string;
  hardware?: { hostname: string; cpu: { logicalCores: number }; memory: { totalBytes: number } };
  heartbeat: { memoryAvailableBytes: number; cpuLoadPercent: number } | null;
  currentTaskId: string | null;
  /** Every job it runs (Hubs from before job slots send only `currentTaskId`). */
  currentTaskIds?: string[];
  /** Those jobs with their desk, once the worker reported it (Hubs before agent names omit it). */
  jobs?: Array<{ taskId: string; job: "implement" | "test"; slot?: number }>;
  /** Jobs it runs at once. */
  slots?: number;
  lastSeenAt: string;
  /** Takes no new jobs (set from the console). */
  draining?: boolean;
  /** A restart from the console: waiting for the current job, or sent and the worker is exiting. */
  restart?: "pending" | "sent" | null;
  /** Set when a service manager restarts the worker; only those can be restarted from here. */
  supervisor?: "systemd";
  /** What a person may do now, decided by the Hub (absent from Hubs older than the console). */
  actions?: { [A in WorkerAction]: boolean } & { why: Partial<Record<WorkerAction, string>> };
  /** The worker key it connected with; null for the Hub's own token (absent from older Hubs). */
  workerKey?: { id: string; name: string } | null;
  /** aso build the node runs (`0.1.0+<commit>`). Optional: Hubs older than the console don't send it. */
  version?: string;
  /** Runs another build than the Hub serves: `aso update` on that machine. */
  outdated?: boolean;
  /** "package": updates itself when the Hub asks (a package install run as a service). */
  updates?: "package";
  /** Set when the restart in `restart` is an automatic update: the build it installs. */
  updateTo?: string | null;
  /** Why the Hub stopped updating this machine to `version` automatically. */
  updateError?: { version: string; reason: string } | null;
}

export interface Project {
  id: string;
  dir: string;
  tasks: { total: number; running: number; queued: number; failed: number; merged: number; reviewing?: number };
  /** Whether QA-approved work becomes a GitHub pull request (absent from Hubs before pull requests). */
  pullRequests?: { enabled: boolean; repo?: string; reason?: string };
  plansAwaitingApproval: number;
  /** Plans whose Architect is waiting for answers (absent from Hubs before plan conversations). */
  plansWithQuestions?: number;
  /** Deploys after merges (absent from Hubs before deploys). */
  deploy?: { configured: boolean; last?: DeployStatus };
}

/** The latest deploy of a project since the Hub started. */
export interface DeployStatus {
  state: "running" | "succeeded" | "failed";
  commit: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** The end of the command's output. */
  output?: string;
}

/** A worker machine's own key (`GET /api/worker-keys`). */
export interface WorkerKey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** The projects it may use; absent: all. */
  projects?: string[];
  /** Absent on an older Hub: trusted. */
  trusted?: boolean;
  budgetUsd?: number;
  spentUsd?: number;
  /** What became of its machine's jobs (absent on an older Hub). */
  track?: Partial<Record<"built" | "qaPassed" | "qaFailed" | "accepted" | "unmet" | "failed" | "dropped" | "tested", number>>;
  connected: boolean;
}

/** The Hub's own update from its repository (`GET /api/hub/update`). */
export interface HubUpdate {
  state: "off" | "current" | "building" | "waiting" | "restarting" | "updated" | "failed";
  /** The aso build the Hub runs. */
  current: string;
  /** The commit being installed, or the one that failed. */
  target?: string;
  error?: string;
  at?: string;
}

export interface Health {
  status: string;
  projectsRoot?: string | null;
  targetDir?: string | null;
  uptimeSec?: number;
}

export interface Llm {
  configured: boolean;
  model: string | null;
  taskBudgetUsd: number;
  totals: { calls: number; costUsd: number };
}

export type TranscriptEntry = { seq: number; at: string } & (
  | { kind: "text"; text: string }
  | { kind: "call"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "result"; id: string; name?: string; content: string; isError: boolean }
  | { kind: "event"; text: string }
  | { kind: "qa"; outcome: "pass" | "fail"; summary: string; output?: string }
);

export interface TranscriptPage {
  entries: TranscriptEntry[];
  last: number;
}

export type CheckState = "passing" | "failing" | "pending" | "skipped";
export type ChecksOverall = "passing" | "failing" | "pending" | "none" | "unknown";

/** The CI checks on a task's pull request (`GET tasks/<id>/checks`). */
export interface ReviewChecks {
  pr: { number: number; url: string };
  headSha: string;
  /** False when it conflicts with main; null while GitHub works it out. */
  mergeable: boolean | null;
  overall: ChecksOverall;
  checks: Array<{ name: string; state: CheckState; url?: string }>;
  /** Why the checks could not be read. */
  error?: string;
}

export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary: boolean;
  /** Left out for binary files and when the diff is too big. */
  patch?: string;
}

/** What a task changes (`GET tasks/<id>/diff`). */
export interface TaskDiff {
  base: string;
  head: string;
  files: DiffFile[];
  truncated: boolean;
}

/** A model desks can use (`GET /api/models`). */
export interface AvailableModel {
  model: string;
  spec: string;
  provider: "anthropic" | "openai-compatible";
  providerId?: string;
  providerLabel?: string;
  baseUrl?: string;
}

export type ProviderPreset = "anthropic" | "openai" | "openrouter" | "gemini" | "groq" | "mistral" | "ollama" | "custom";

/** A model provider (`GET /api/providers`): never its key, only whether it has one. */
export interface Provider {
  id: string;
  preset: ProviderPreset;
  kind: "anthropic" | "openai-compatible";
  label: string;
  source: "added" | "environment";
  hasKey: boolean;
  baseUrl?: string;
  vision?: boolean;
  models?: number;
  error?: string;
}

/** A model's price, USD per million tokens (`GET /api/prices`). */
export interface Price {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  source: "built-in" | "set";
}

export interface Models {
  architect: string | null;
  /** The acceptance check's model (absent from older Hubs: the Architect's). */
  reviewer?: string | null;
  defaultAgent: string | null;
  available: AvailableModel[];
  localError?: string;
}

/** After `juniorTries` tries on its desk's model, a task moves up the `ladder` (weakest first). */
export interface EscalationPolicy {
  ladder: string[];
  juniorTries: number;
}

/** Which desks use a model of their own (`GET /api/desks`). */
export interface Desks {
  architect: string | null;
  reviewer?: string | null;
  /** The roles put on a model of their own (absent from older Hubs). */
  roles?: { architect?: string; reviewer?: string };
  /** Where a failing task moves (null: escalation is off; absent from older Hubs). */
  escalation?: EscalationPolicy | null;
  /** What was changed while the Hub runs (absent: its start settings). */
  escalationSet?: Partial<EscalationPolicy>;
  defaultAgent: string | null;
  desks: Array<{ desk: string; model: string }>;
  models: Array<{ model: string; baseUrl?: string; concurrency: number; running: number; waiting: number }>;
}

export type TrackRecordKey = "model" | "host" | "desk" | "role" | "project";

/** One model's, machine's, desk's, role's or project's record (`GET /api/track-records`). */
export interface TrackRecordRow {
  key: string;
  builds: {
    jobs: number;
    built: number;
    unverified: number;
    failed: number;
    outOfTurns: number;
    modelRefused: number;
    dropped: number;
    cancelled: number;
    qaPassed: number;
    qaFailed: number;
    accepted: number;
    unmet: number;
  };
  qaRuns: { runs: number; passed: number; failed: number; errors: number; dropped: number };
  tasks: { worked: number; finished: number; firstTry: number; tookOver: number };
  costUsd: number;
  /** Its own builds' cost per task it finished. */
  costPerFinishedUsd?: number;
  /** The settled tasks whose first build was its, with everything they cost (absent from older Hubs). */
  started?: { settled: number; finished: number; costUsd: number; costPerFinishedUsd?: number };
  /** Plans made with it, as the Architect's model (by model and project only). */
  plans: { planned: number; proposed: number; approved: number; rejected: number; failed: number; withQuestions: number; costUsd: number };
  /** Acceptance checks it made, as the reviewer's model (by model and project only); `overturned`: met verdicts proved wrong later (absent from older Hubs). */
  reviews: { checks: number; met: number; overturned?: number; unmet: number; undecided: number; costUsd: number };
}

export interface TrackRecords {
  by: TrackRecordKey;
  since: string | null;
  rows: TrackRecordRow[];
}

export type SuggestionRole = "desks" | "reviewer" | "architect";

/** How a model has done in a role (`GET /api/model-suggestions`). */
export interface SuggestionEvidence {
  model: string;
  samples: number;
  /** 0 to 1: tasks finished of those settled; met verdicts that held up; proposed plans approved. */
  quality: number;
  unitCostUsd: number;
}

export interface ModelSuggestion {
  role: SuggestionRole;
  kind: "cheaper" | "better";
  current: SuggestionEvidence;
  suggested: SuggestionEvidence;
  /** How to choose it; absent when no provider offers it now. */
  spec?: string;
  /** What applies it: each connected machine's desks, or the role; empty when no provider offers it now. */
  apply: Array<{ kind: "desk" | "role"; target: string; model: string }>;
  reason: string;
}

export interface ModelSuggestions {
  since: string;
  suggestions: ModelSuggestion[];
  notes: Array<{ role: SuggestionRole; text: string }>;
}
