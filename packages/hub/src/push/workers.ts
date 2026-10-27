import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@aso/shared";
import type { Registration } from "../registry.js";
import type { PushNotification } from "./changes.js";
import { JsonFileWriter } from "./json-file.js";

const log = createLogger("push");

/** How long a machine's workers may be gone before anyone is told: rides out restarts, updates and short sleeps. */
export const WORKER_OFFLINE_ALERT_MS = 10 * 60_000;
/** A machine gone this long is forgotten (a retired one): it gets one alert, not one per Hub restart forever. */
export const WORKER_FORGET_MS = 14 * 24 * 3_600_000;

interface Machine {
  /** Connected worker node ids from this machine (a reconnect may overlap the old connection). */
  nodes: Set<string>;
  /** When a worker from it was last connected: what the notifications report, and what forgetting goes by. */
  lastSeenAt: number;
  /**
   * When the alert delay started: the same as `lastSeenAt` when its last worker left under this
   * Hub, but the Hub's start for a machine remembered from before a restart, so it gets the full
   * delay to reconnect. Unused while a worker is connected.
   */
  graceStartedAt: number;
  alerted: boolean;
}

interface SavedMachine {
  lastSeenAt: string;
  alerted?: boolean;
}

export interface WorkerWatchOptions {
  /** Folder for `workers.json`, so a machine gone across a Hub restart is still noticed. Undefined keeps it in memory. */
  dir?: string;
  alertMs?: number;
  now?: number;
}

/**
 * Tells you when a worker machine has been gone for a while, and when it is back. Machines are
 * known by hostname, since a worker gets a new node id on each connection. Each outage alerts once.
 */
export class WorkerWatch {
  private readonly writer?: JsonFileWriter;

  private constructor(
    private readonly machines: Map<string, Machine>,
    private readonly opts: WorkerWatchOptions,
  ) {
    if (opts.dir) this.writer = new JsonFileWriter(path.join(opts.dir, "workers.json"));
  }

  static async open(opts: WorkerWatchOptions = {}): Promise<WorkerWatch> {
    const now = opts.now ?? Date.now();
    const machines = new Map<string, Machine>();
    const file = opts.dir && path.join(opts.dir, "workers.json");
    if (file) {
      try {
        for (const [host, m] of Object.entries(JSON.parse(await readFile(file, "utf8")) as Record<string, SavedMachine>)) {
          const lastSeenAt = Date.parse(m?.lastSeenAt);
          // Counted from now: the machine may simply not have reconnected to the new Hub yet.
          if (Number.isFinite(lastSeenAt)) machines.set(host, { nodes: new Set(), lastSeenAt, graceStartedAt: now, alerted: m.alerted === true });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`could not read ${file} (${(err as Error).message}); starting without known workers`);
      }
    }
    return new WorkerWatch(machines, opts);
  }

  /** A node registered. For a worker, returns the "back" notification when its machine's outage was announced. */
  registered(nodeId: string, registration: Registration, now = Date.now()): PushNotification | undefined {
    if (registration.nodeKind !== "worker") return undefined;
    const host = registration.hardware.hostname;
    const m = this.machines.get(host) ?? { nodes: new Set<string>(), lastSeenAt: now, graceStartedAt: now, alerted: false };
    const announcedOffline = m.alerted && m.nodes.size === 0;
    const back = announcedOffline ? workerBack(host, now - m.lastSeenAt) : undefined;
    m.nodes.add(nodeId);
    m.lastSeenAt = now;
    m.alerted = false;
    this.machines.set(host, m);
    void this.save();
    return back;
  }

  /** A node's connection ended (closed or timed out). */
  dropped(nodeId: string, registration: Registration, now = Date.now()): void {
    if (registration.nodeKind !== "worker") return;
    const m = this.machines.get(registration.hardware.hostname);
    if (!m?.nodes.delete(nodeId)) return;
    m.lastSeenAt = now;
    if (m.nodes.size === 0) m.graceStartedAt = now;
    void this.save();
  }

  /** Machines gone longer than the alert delay and not yet announced; forgets long-gone ones. */
  check(now = Date.now()): PushNotification[] {
    const alertMs = this.opts.alertMs ?? WORKER_OFFLINE_ALERT_MS;
    const out: PushNotification[] = [];
    let changed = false;
    for (const [host, m] of this.machines) {
      if (m.nodes.size > 0) continue;
      if (now - m.lastSeenAt >= WORKER_FORGET_MS) {
        this.machines.delete(host);
        changed = true;
      } else if (!m.alerted && now - m.graceStartedAt >= alertMs) {
        m.alerted = true;
        changed = true;
        out.push(workerOffline(host, now - m.lastSeenAt));
      }
    }
    if (changed) void this.save();
    return out;
  }

  /** Resolves once the machines' state is on disk (a disconnect saves it as the Hub closes). */
  async flush(): Promise<void> {
    await this.writer?.idle();
  }

  private save(): Promise<unknown> {
    const data: Record<string, SavedMachine> = {};
    for (const [host, m] of this.machines) data[host] = { lastSeenAt: new Date(m.lastSeenAt).toISOString(), ...(m.alerted ? { alerted: true } : {}) };
    return this.writer?.write(data) ?? Promise.resolve();
  }
}

function workerOffline(host: string, goneMs: number): PushNotification {
  return {
    title: `Worker ${host} is offline`,
    body: `Last seen ${duration(goneMs)} ago. Its tasks wait for another worker. On ${host}, \`aso service status\` shows why.`,
    url: "/",
    tag: `worker-${host}`,
  };
}

function workerBack(host: string, goneMs: number): PushNotification {
  return { title: `Worker ${host} is back`, body: `It was offline for ${duration(goneMs)}.`, url: "/", tag: `worker-${host}` };
}

/** Rough and short: "12 min", "3 h", "2 days". */
export function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}
