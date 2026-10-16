import {
  DEFAULT_SLOTS,
  HUB_NODE_ID,
  createMessage,
  type AgentMessageType,
  type MessageOf,
  type PayloadInput,
} from "@aso/shared";
import type { NodeSnapshot } from "./routing.js";

export type Registration = MessageOf<"NODE_REGISTRATION">["payload"];
export type Heartbeat = MessageOf<"NODE_HEARTBEAT">["payload"];

export interface NodeTransport {
  send(raw: string): void;
  close(code: number, reason: string): void;
  /** Drop the connection without waiting for a close handshake (dead peers never answer). */
  terminate(): void;
}

export interface NodeEntry {
  nodeId: string;
  registration: Registration;
  transport: NodeTransport;
  connectedAt: number;
  lastSeenAt: number;
  heartbeat?: Heartbeat;
  /** Tasks (workers) or plans (Architect) the node is working on; at most `slots`. */
  jobs: Set<string>;
  /** Jobs it runs at once: what a worker registered with (1 for older workers and the Architect). */
  slots: number;
  lastAssignedAt?: number;
  /** Takes no new jobs; set by a person from the console, or by a pending restart. */
  draining?: boolean;
  /** Restart once idle: "pending" until the restart is sent, then "sent" until the node disconnects. */
  restart?: "pending" | "sent";
  /** Set when that restart is an automatic update: the build to install first. */
  updateTo?: string;
}

/** Automatic updates to one build, per machine (a worker comes back under a new node id). */
interface UpdateRecord {
  version: string;
  /** Updates sent to this machine for `version`. */
  attempts: number;
  /** Why the machine is left alone for `version`: the install failed, or it kept coming back on its old build. */
  error?: string;
}

/** Updates sent to one machine for one build before the Hub stops trying (a worker that comes back unchanged). */
export const MAX_UPDATE_ATTEMPTS = 2;

export class NodeError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict",
  ) {
    super(message);
  }
}

/** Live registry of connected nodes (workers and the Architect). */
export class NodeRegistry {
  private readonly nodes = new Map<string, NodeEntry>();
  /** By hostname. */
  private readonly updates = new Map<string, UpdateRecord>();

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  get(nodeId: string): NodeEntry | undefined {
    return this.nodes.get(nodeId);
  }

  register(nodeId: string, registration: Registration, transport: NodeTransport, now = Date.now()): NodeEntry {
    if (this.nodes.has(nodeId)) throw new Error(`node ${nodeId} already registered`);
    const slots = registration.nodeKind === "worker" ? (registration.slots ?? DEFAULT_SLOTS) : DEFAULT_SLOTS;
    const entry: NodeEntry = { nodeId, registration, transport, connectedAt: now, lastSeenAt: now, jobs: new Set(), slots };
    this.nodes.set(nodeId, entry);
    return entry;
  }

  /**
   * Remove a node. When `transport` is given, only removes the entry if it still belongs to
   * that connection, so a late close event cannot evict a node that has since reconnected.
   */
  unregister(nodeId: string, transport?: NodeTransport): NodeEntry | undefined {
    const entry = this.nodes.get(nodeId);
    if (!entry || (transport && entry.transport !== transport)) return undefined;
    this.nodes.delete(nodeId);
    return entry;
  }

  touch(nodeId: string, now = Date.now()): void {
    const entry = this.nodes.get(nodeId);
    if (entry) entry.lastSeenAt = now;
  }

  /**
   * Record a worker's heartbeat. Returns whether Docker is now available when that changed:
   * the registered hardware profile follows the heartbeats, so a check that failed once at
   * startup (or Docker stopping later) is not kept on record.
   */
  setHeartbeat(nodeId: string, heartbeat: Heartbeat): boolean | undefined {
    const entry = this.nodes.get(nodeId);
    if (!entry) return undefined;
    entry.heartbeat = heartbeat;
    const reg = entry.registration;
    if (reg.nodeKind !== "worker" || reg.hardware.docker.available === heartbeat.dockerAvailable) return undefined;
    reg.hardware.docker = { available: heartbeat.dockerAvailable };
    return heartbeat.dockerAvailable;
  }

  /** Give a node a task (workers) or a plan (Architect); it is busy once all its slots are taken. */
  assign(nodeId: string, taskId: string, now = Date.now()): void {
    const entry = this.require(nodeId);
    entry.jobs.add(taskId);
    entry.lastAssignedAt = now;
  }

  release(nodeId: string, taskId: string): void {
    const entry = this.nodes.get(nodeId);
    if (!entry?.jobs.delete(taskId)) return;
    this.restartIfIdle(entry);
  }

  /** Whether the node has no free slot. */
  isFull(nodeId: string): boolean {
    const entry = this.nodes.get(nodeId);
    return !!entry && freeSlotsOf(entry) === 0;
  }

  /*
   * Draining and restarting a worker from the console:
   *
   *   idle/busy --drain--> draining --resume--> idle/busy
   *   idle/busy/draining --restart--> restart "pending" (draining) --job released--> "sent"
   *   restart "pending" --resume--> idle/busy   (cancels the restart)
   *   restart "sent": the worker exits; its entry goes when it disconnects
   *
   * What a person may do in each state is `nodeActions`, which the console shows as buttons.
   */

  /** Give a worker no new jobs; its current job carries on. */
  drain(nodeId: string): NodeEntry {
    const entry = this.requireActionable(nodeId, "drain");
    entry.draining = true;
    return entry;
  }

  /** Give a drained worker jobs again. This also cancels a restart (or update) that is still waiting for a job. */
  resume(nodeId: string): NodeEntry {
    const entry = this.requireActionable(nodeId, "resume");
    clearRestart(entry);
    return entry;
  }

  /**
   * Restart a worker once its current job is done: it takes no new jobs meanwhile, then gets
   * NODE_CONTROL restart and exits for its service manager to start it again (on the build
   * installed there, so this also finishes an `aso update`). It comes back as a new node.
   */
  requestRestart(nodeId: string): NodeEntry {
    const entry = this.requireActionable(nodeId, "restart");
    entry.draining = true;
    entry.restart = "pending";
    this.restartIfIdle(entry);
    return entry;
  }

  /**
   * A worker registered on another build than `version`, the one this Hub serves: have it update
   * itself like a restart (no new jobs, then NODE_CONTROL update once idle). Returns why not,
   * or undefined when the update is on its way.
   */
  requestUpdate(nodeId: string, version: string): string | undefined {
    const entry = this.nodes.get(nodeId);
    const reg = entry?.registration;
    if (!entry || reg?.nodeKind !== "worker") return "it is not a connected worker";
    if (reg.updates !== "package" || reg.supervisor === undefined) {
      return "it cannot update itself (it runs from a source checkout, or was not started by aso service install)";
    }
    if (entry.restart !== undefined) return "it is already restarting";
    const host = reg.hardware.hostname;
    let record = this.updates.get(host);
    if (record?.version !== version) record = { version, attempts: 0 };
    if (!record.error && record.attempts >= MAX_UPDATE_ATTEMPTS) {
      record.error = `it came back on ${reg.version} after ${record.attempts} updates`;
    }
    this.updates.set(host, record);
    if (record.error) return `the update to ${version} failed: ${record.error}`;
    record.attempts++;
    entry.draining = true;
    entry.restart = "pending";
    entry.updateTo = version;
    this.restartIfIdle(entry);
    return undefined;
  }

  /**
   * A worker reports that installing the update failed: its machine is not asked again for this
   * build (recorded even if the Hub did not ask: the worker cannot install it either way), and a
   * worker the update drained takes jobs again.
   */
  updateFailed(nodeId: string, version: string, reason: string): void {
    const entry = this.nodes.get(nodeId);
    if (!entry || entry.registration.nodeKind !== "worker") return;
    this.updates.set(entry.registration.hardware.hostname, { version, attempts: MAX_UPDATE_ATTEMPTS, error: reason });
    if (entry.updateTo !== undefined) clearRestart(entry);
  }

  /** A worker registered on the build the Hub serves: forget its machine's update attempts. */
  workerCurrent(nodeId: string): void {
    const reg = this.nodes.get(nodeId)?.registration;
    if (reg?.nodeKind === "worker") this.updates.delete(reg.hardware.hostname);
  }

  /** Sends NODE_CONTROL to a worker with a pending restart or update once it has no job. Called on every release. */
  private restartIfIdle(entry: NodeEntry): void {
    if (entry.restart !== "pending" || entry.jobs.size > 0) return;
    try {
      this.send(entry.nodeId, "NODE_CONTROL", entry.updateTo ? { action: "update", version: entry.updateTo } : { action: "restart" });
      entry.restart = "sent";
    } catch {
      // The socket is closing; the node is about to drop, and its entry with it. Never let this break the release.
    }
  }

  private requireActionable(nodeId: string, action: NodeAction): NodeEntry {
    const entry = this.nodes.get(nodeId);
    if (!entry || entry.registration.nodeKind !== "worker") throw new NodeError(`worker ${nodeId} is not connected`, "not_found");
    const actions = nodeActions(entry);
    if (!actions[action]) throw new NodeError(actions.why[action] ?? `cannot ${action} ${nodeId} now`, "conflict");
    return entry;
  }

  /** Nodes whose last message is older than `timeoutMs`. */
  stale(timeoutMs: number, now = Date.now()): NodeEntry[] {
    return [...this.nodes.values()].filter((n) => now - n.lastSeenAt > timeoutMs);
  }

  send<T extends AgentMessageType>(nodeId: string, type: T, payload: PayloadInput<T>): void {
    this.require(nodeId).transport.send(JSON.stringify(createMessage(type, HUB_NODE_ID, payload)));
  }

  /** Routing view of all connected workers. */
  workerSnapshots(): NodeSnapshot[] {
    const out: NodeSnapshot[] = [];
    for (const n of this.nodes.values()) {
      if (n.registration.nodeKind !== "worker") continue;
      out.push({
        nodeId: n.nodeId,
        hardware: n.registration.hardware,
        load: n.heartbeat,
        slots: n.slots,
        freeSlots: freeSlotsOf(n),
        draining: n.draining === true,
        lastAssignedAt: n.lastAssignedAt,
      });
    }
    return out;
  }

  /** JSON-safe view of every node for the API / dashboard. */
  list() {
    return [...this.nodes.values()].map((n) => this.view(n));
  }

  /** JSON-safe view of one node. */
  view(n: NodeEntry) {
    const jobs = [...n.jobs];
    return {
      nodeId: n.nodeId,
      connectedAt: new Date(n.connectedAt).toISOString(),
      lastSeenAt: new Date(n.lastSeenAt).toISOString(),
      // Consoles from before slots read only the first job.
      currentTaskId: jobs[0] ?? null,
      currentTaskIds: jobs,
      slots: n.slots,
      heartbeat: n.heartbeat ?? null,
      draining: n.draining === true,
      restart: n.restart ?? null,
      /** The build an automatic update installs (the restart above is that update). */
      updateTo: n.updateTo ?? null,
      /** Why this machine is not updated automatically to the build named in it. */
      updateError: this.updateErrorOf(n),
      actions: nodeActions(n),
      ...publicRegistration(n.registration),
    };
  }

  private updateErrorOf(n: NodeEntry): { version: string; reason: string } | null {
    if (n.registration.nodeKind !== "worker") return null;
    const record = this.updates.get(n.registration.hardware.hostname);
    return record?.error ? { version: record.version, reason: record.error } : null;
  }

  private require(nodeId: string): NodeEntry {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`unknown node ${nodeId}`);
    return entry;
  }
}

/** Undo a pending restart or update, and the draining that came with it. */
function clearRestart(entry: NodeEntry): void {
  entry.draining = undefined;
  entry.restart = undefined;
  entry.updateTo = undefined;
}

function freeSlotsOf(n: NodeEntry): number {
  return Math.max(0, n.slots - n.jobs.size);
}

/** The registration minus what a worker was running when it registered: stale at once (`currentTaskIds` is live). */
function publicRegistration(registration: Registration) {
  if (registration.nodeKind !== "worker") return registration;
  const { running: _running, resume: _resume, ...rest } = registration;
  return rest;
}

export type NodeAction = "drain" | "resume" | "restart";

/** What a person may do with a node now; `why` explains a refusal that is not obvious from the state. */
export type NodeActions = Record<NodeAction, boolean> & { why: Partial<Record<NodeAction, string>> };

/** The single source of the drain/resume/restart rules: the API enforces them and the console shows them. */
export function nodeActions(n: Pick<NodeEntry, "registration" | "draining" | "restart">): NodeActions {
  if (n.registration.nodeKind !== "worker") return { drain: false, resume: false, restart: false, why: {} };
  const restarting = n.restart !== undefined;
  const service = n.registration.supervisor !== undefined;
  return {
    drain: !n.draining && !restarting,
    resume: n.draining === true && n.restart !== "sent",
    restart: service && !restarting,
    why: {
      ...(n.restart === "sent" ? { resume: "the worker is already restarting" } : {}),
      ...(service
        ? {}
        : { restart: "this worker was started by hand, so nothing would start it again: on its machine, stop it and run aso service install (after aso update)" }),
    },
  };
}

/**
 * Whether a node runs a different aso build than the one this Hub serves (`aso update` on it
 * would change it). Unknown when the Hub has no package to compare with.
 */
export function isOutdated(nodeVersion: string, hubVersion: string | undefined): boolean {
  return hubVersion !== undefined && nodeVersion !== hubVersion;
}
