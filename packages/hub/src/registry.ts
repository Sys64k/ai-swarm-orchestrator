import {
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
  currentTaskId?: string;
  lastAssignedAt?: number;
}

/** Live registry of connected nodes (workers and the Architect). */
export class NodeRegistry {
  private readonly nodes = new Map<string, NodeEntry>();

  has(nodeId: string): boolean {
    return this.nodes.has(nodeId);
  }

  get(nodeId: string): NodeEntry | undefined {
    return this.nodes.get(nodeId);
  }

  register(nodeId: string, registration: Registration, transport: NodeTransport, now = Date.now()): NodeEntry {
    if (this.nodes.has(nodeId)) throw new Error(`node ${nodeId} already registered`);
    const entry: NodeEntry = { nodeId, registration, transport, connectedAt: now, lastSeenAt: now };
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

  setHeartbeat(nodeId: string, heartbeat: Heartbeat): void {
    const entry = this.nodes.get(nodeId);
    if (entry) entry.heartbeat = heartbeat;
  }

  /** Mark a node busy with a task (workers) or a plan (Architect). */
  assign(nodeId: string, taskId: string, now = Date.now()): void {
    const entry = this.require(nodeId);
    entry.currentTaskId = taskId;
    entry.lastAssignedAt = now;
  }

  release(nodeId: string, taskId: string): void {
    const entry = this.nodes.get(nodeId);
    if (entry?.currentTaskId === taskId) entry.currentTaskId = undefined;
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
        roles: n.registration.roles,
        hardware: n.registration.hardware,
        load: n.heartbeat,
        busy: n.currentTaskId !== undefined,
        lastAssignedAt: n.lastAssignedAt,
      });
    }
    return out;
  }

  /** JSON-safe view for the API / dashboard. */
  list() {
    return [...this.nodes.values()].map((n) => ({
      nodeId: n.nodeId,
      connectedAt: new Date(n.connectedAt).toISOString(),
      lastSeenAt: new Date(n.lastSeenAt).toISOString(),
      currentTaskId: n.currentTaskId ?? null,
      heartbeat: n.heartbeat ?? null,
      ...n.registration,
    }));
  }

  private require(nodeId: string): NodeEntry {
    const entry = this.nodes.get(nodeId);
    if (!entry) throw new Error(`unknown node ${nodeId}`);
    return entry;
  }
}

/**
 * Whether a node runs a different aso build than the one this Hub serves (`aso update` on it
 * would change it). Unknown when the Hub has no package to compare with.
 */
export function isOutdated(nodeVersion: string, hubVersion: string | undefined): boolean {
  return hubVersion !== undefined && nodeVersion !== hubVersion;
}
