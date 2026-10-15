/** The parts of the Hub's API responses the console uses. */

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

export type PlanState = "pending" | "planning" | "proposed" | "approved" | "rejected" | "failed";

export interface HistoryEntry {
  at: string;
  event: string;
}

export interface Task {
  /** The project (folder in the Hub's projects root) the task belongs to. */
  project: string;
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
  error?: string;
  llm: { calls: number; costUsd: number };
  createdAt: string;
  updatedAt: string;
  history: HistoryEntry[];
}

export interface HubNode {
  nodeId: string;
  nodeKind: "worker" | "architect";
  roles?: string[];
  hardware?: { hostname: string; cpu: { logicalCores: number }; memory: { totalBytes: number } };
  heartbeat: { memoryAvailableBytes: number; cpuLoadPercent: number } | null;
  currentTaskId: string | null;
  lastSeenAt: string;
  /** aso build the node runs (`0.1.0+<commit>`). Optional: Hubs older than the console don't send it. */
  version?: string;
  /** Runs another build than the Hub serves: `aso update` on that machine. */
  outdated?: boolean;
}

export interface Project {
  id: string;
  dir: string;
  tasks: { total: number; running: number; queued: number; failed: number; merged: number };
  plansAwaitingApproval: number;
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
