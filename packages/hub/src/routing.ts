import type { HardwareProfile, TaskKind, WorkerRole } from "@aso/shared";

const GiB = 1024 ** 3;

/**
 * Hard constraints filter nodes out. The rest are ranked by how many jobs they already run
 * (fewest first, so work spreads over the fleet's machines), then by the weights. Each
 * weighted metric is normalised against the best eligible node, so scores are relative to the
 * current fleet.
 */
export interface RoutingPolicy {
  requiresDocker?: boolean;
  minMemoryBytes?: number;
  weights: { memory: number; io: number; cpu: number };
}

export type RoutingPolicies = Record<TaskKind, RoutingPolicy>;

export const DEFAULT_ROUTING_POLICIES: RoutingPolicies = {
  feature: { weights: { memory: 0.2, io: 0.2, cpu: 0.6 } },
  unit_test: { weights: { memory: 0.3, io: 0.2, cpu: 0.5 } },
  // Browsers are memory hungry: prefer the most free RAM, never schedule on tiny nodes.
  e2e_test: { minMemoryBytes: 4 * GiB, weights: { memory: 0.7, io: 0.1, cpu: 0.2 } },
  db_migration: { weights: { memory: 0.1, io: 0.8, cpu: 0.1 } },
  container_build: { requiresDocker: true, weights: { memory: 0.3, io: 0.3, cpu: 0.4 } },
};

export interface RoutingRequest {
  role: WorkerRole;
  kind: TaskKind;
  /**
   * A node to keep off this job while another one is eligible, e.g. QA avoids the node that wrote
   * the code. It still gets the job when it is the only eligible node.
   */
  avoid?: string;
}

/** What the router needs to know about a worker. */
export interface NodeSnapshot {
  nodeId: string;
  hardware: HardwareProfile;
  /** Latest heartbeat; falls back to registration-time values when absent. */
  load?: { memoryAvailableBytes: number; cpuLoadPercent: number; dockerAvailable: boolean };
  /** Jobs it runs at once, and how many of those are free; it is busy at 0. */
  slots: number;
  freeSlots: number;
  /** Set from the console: finishes its current job but takes no new ones. */
  draining?: boolean;
  /** Epoch ms of the last assignment, used to spread ties across nodes. */
  lastAssignedAt?: number;
}

export interface RankedNode {
  nodeId: string;
  score: number;
  metrics: { memoryAvailableBytes: number; writeMBps: number; effectiveCores: number };
}

export type RoutingDecision =
  | { ok: true; nodeId: string; score: number; reasons: string[]; ranking: RankedNode[] }
  | { ok: false; reason: string; rejected: Array<{ nodeId: string; reason: string }> };

/** Pick the best worker for a task. Pure: no I/O, no mutation. */
export function selectNode(
  request: RoutingRequest,
  nodes: readonly NodeSnapshot[],
  policies: RoutingPolicies = DEFAULT_ROUTING_POLICIES,
): RoutingDecision {
  const policy = policies[request.kind];
  const rejected: Array<{ nodeId: string; reason: string }> = [];
  const eligible: Array<{ node: NodeSnapshot; metrics: RankedNode["metrics"] }> = [];

  for (const node of nodes) {
    const metrics = metricsOf(node);
    const reason = rejectionReason(node, request, policy);
    if (reason) rejected.push({ nodeId: node.nodeId, reason });
    else eligible.push({ node, metrics });
  }

  const others = request.avoid ? eligible.filter((e) => e.node.nodeId !== request.avoid) : eligible;
  const avoided = others.length > 0 && others.length < eligible.length;
  if (avoided) eligible.splice(0, eligible.length, ...others);

  if (eligible.length === 0) {
    return {
      ok: false,
      reason: nodes.length
        ? `no eligible node for ${request.role}/${request.kind}`
        : "no worker nodes connected",
      rejected,
    };
  }

  const max = {
    memory: Math.max(...eligible.map((e) => e.metrics.memoryAvailableBytes)),
    io: Math.max(...eligible.map((e) => e.metrics.writeMBps)),
    cpu: Math.max(...eligible.map((e) => e.metrics.effectiveCores)),
  };
  const norm = (v: number, m: number) => (m > 0 ? v / m : 0);
  const { weights } = policy;

  const ranking: Array<RankedNode & { running: number; lastAssignedAt: number; node: NodeSnapshot }> = eligible
    .map(({ node, metrics }) => ({
      nodeId: node.nodeId,
      node,
      metrics,
      running: runningJobs(node),
      lastAssignedAt: node.lastAssignedAt ?? 0,
      // A node already running jobs shares its machine with them: scale by its free share of slots.
      score: round(
        freeShare(node) *
          (weights.memory * norm(metrics.memoryAvailableBytes, max.memory) +
            weights.io * norm(metrics.writeMBps, max.io) +
            weights.cpu * norm(metrics.effectiveCores, max.cpu)),
      ),
    }))
    // The machine running the fewest jobs wins, so parallel work runs on parallel machines:
    // agents mostly wait for the model, and builds and tests on one machine compete for it.
    // Among those, the highest score; near-ties go to the node that has waited longest.
    .sort((a, b) =>
      a.running !== b.running
        ? a.running - b.running
        : Math.abs(a.score - b.score) > 0.01
          ? b.score - a.score
          : a.lastAssignedAt - b.lastAssignedAt,
    );

  const best = ranking[0];
  const busier = ranking.filter((r) => r.running > best.running);
  return {
    ok: true,
    nodeId: best.nodeId,
    score: best.score,
    reasons: [
      ...explain(request, policy, best.metrics, eligible.length),
      ...(best.node.slots > 1 ? [`${best.node.freeSlots} of ${best.node.slots} job slots free`] : []),
      ...(busier.length ? [`over ${busier.map((r) => r.nodeId).join(", ")}, which ${busier.length === 1 ? "is" : "are"} busier`] : []),
      ...(avoided ? [`not ${request.avoid}, which wrote the code`] : request.avoid === best.nodeId ? ["no other node free, so the node that wrote the code"] : []),
    ],
    ranking: ranking.map(({ lastAssignedAt: _, node: __, running: ___, ...r }) => r),
  };
}

/** Jobs the node runs now. */
function runningJobs(node: NodeSnapshot): number {
  return Math.max(0, node.slots - node.freeSlots);
}

/** Share of the node's slots that is free (1 for a free one-slot node). */
function freeShare(node: NodeSnapshot): number {
  return node.slots > 0 ? node.freeSlots / node.slots : 0;
}

function metricsOf(node: NodeSnapshot): RankedNode["metrics"] {
  const memoryAvailableBytes = node.load?.memoryAvailableBytes ?? node.hardware.memory.availableBytes;
  const cpuLoad = (node.load?.cpuLoadPercent ?? 0) / 100;
  return {
    memoryAvailableBytes,
    writeMBps: node.hardware.storage.writeMBps,
    effectiveCores: round(node.hardware.cpu.logicalCores * (1 - cpuLoad)),
  };
}

function rejectionReason(node: NodeSnapshot, req: RoutingRequest, policy: RoutingPolicy): string | undefined {
  if (node.freeSlots === 0) return "busy";
  if (node.draining) return "draining";
  const docker = node.load?.dockerAvailable ?? node.hardware.docker.available;
  if (policy.requiresDocker && !docker) return "no Docker daemon";
  if (policy.minMemoryBytes && node.hardware.memory.totalBytes < policy.minMemoryBytes) {
    return `RAM ${fmtGiB(node.hardware.memory.totalBytes)} below ${fmtGiB(policy.minMemoryBytes)} minimum`;
  }
  return undefined;
}

function explain(
  req: RoutingRequest,
  policy: RoutingPolicy,
  m: RankedNode["metrics"],
  candidates: number,
): string[] {
  const reasons = [`best of ${candidates} eligible node(s) for ${req.role}/${req.kind}`];
  if (policy.requiresDocker) reasons.push("has a running Docker daemon");
  const dominant = Object.entries(policy.weights).sort((a, b) => b[1] - a[1])[0][0];
  if (dominant === "memory") reasons.push(`${fmtGiB(m.memoryAvailableBytes)} RAM available`);
  if (dominant === "io") reasons.push(`${m.writeMBps} MB/s disk write`);
  if (dominant === "cpu") reasons.push(`${m.effectiveCores} effective cores`);
  return reasons;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const fmtGiB = (b: number) => `${(b / GiB).toFixed(1)} GiB`;
