import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import {
  DEFAULT_HUB_PORT,
  HUB_NODE_ID,
  NODE_TIMEOUT_MS,
  NODE_TO_HUB_TYPES,
  WS_PATH,
  createLogger,
  createMessage,
  parseAgentMessage,
  type AgentMessage,
} from "@aso/shared";
import { NodeRegistry, type NodeTransport } from "./registry.js";
import type { RoutingPolicies } from "./routing.js";
import { TaskError, TaskManager } from "./tasks.js";

const log = createLogger("hub");

/** Frames larger than this are rejected before parsing. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface HubOptions {
  /** Absolute path to the target project repository the swarm operates on. */
  targetDir: string;
  port?: number;
  host?: string;
  policies?: RoutingPolicies;
  /** Drop nodes silent for longer than this. */
  nodeTimeoutMs?: number;
}

export interface HubHandle {
  port: number;
  registry: NodeRegistry;
  tasks: TaskManager;
  close(): Promise<void>;
}

interface Connection {
  connId: string;
  ws: WSContext;
  /** Set once the node has sent a valid NODE_REGISTRATION. */
  nodeId?: string;
  transport?: NodeTransport;
}

export async function startHub(opts: HubOptions): Promise<HubHandle> {
  const port = opts.port ?? DEFAULT_HUB_PORT;
  const host = opts.host ?? "0.0.0.0";
  const nodeTimeoutMs = opts.nodeTimeoutMs ?? NODE_TIMEOUT_MS;
  const connections = new Map<string, Connection>();
  const registry = new NodeRegistry();
  const tasks = new TaskManager(registry, { policies: opts.policies });

  /** Idempotent: safe to call from both the timeout sweep and the socket close event. */
  const dropNode = (nodeId: string, transport: NodeTransport) => {
    if (registry.unregister(nodeId, transport)) tasks.handleNodeGone(nodeId);
  };

  const reject = (conn: Connection, reason: string, issues: string[] = [], refId?: string) => {
    log.warn(`rejected message from ${conn.nodeId ?? conn.connId}: ${reason}`, issues.length ? issues : undefined);
    conn.ws.send(JSON.stringify(createMessage("PROTOCOL_ERROR", HUB_NODE_ID, { reason, issues, refId })));
  };

  const handleMessage = (conn: Connection, msg: AgentMessage) => {
    if (!NODE_TO_HUB_TYPES.has(msg.type)) {
      return reject(conn, `nodes may not send ${msg.type}`, [], msg.id);
    }

    if (msg.type === "NODE_REGISTRATION") {
      if (conn.nodeId) return reject(conn, "already registered", [], msg.id);
      if (msg.from === HUB_NODE_ID || registry.has(msg.from)) {
        reject(conn, `node id "${msg.from}" is already in use`, [], msg.id);
        return conn.ws.close(4009, "duplicate node id");
      }
      conn.nodeId = msg.from;
      conn.transport = {
        send: (raw) => conn.ws.send(raw),
        close: (code, reason) => conn.ws.close(code, reason),
        terminate: () => (conn.ws.raw as { terminate?: () => void } | undefined)?.terminate?.(),
      };
      registry.register(msg.from, msg.payload, conn.transport);
      const p = msg.payload;
      log.info(
        p.nodeKind === "worker"
          ? `worker ${msg.from} registered from ${p.hardware.hostname} (roles: ${p.roles.join(", ")}, ` +
              `${(p.hardware.memory.totalBytes / 1024 ** 3).toFixed(1)} GiB, ${p.hardware.storage.writeMBps} MB/s, ` +
              `docker ${p.hardware.docker.available ? "yes" : "no"})`
          : `architect ${msg.from} registered`,
      );
      registry.send(msg.from, "REGISTRATION_ACK", { nodeId: msg.from });
      return tasks.dispatch();
    }

    if (!conn.nodeId) return reject(conn, "NODE_REGISTRATION required first", [], msg.id);
    if (msg.from !== conn.nodeId) {
      return reject(conn, `envelope from "${msg.from}" does not match registered node`, [], msg.id);
    }
    registry.touch(conn.nodeId);

    switch (msg.type) {
      case "NODE_HEARTBEAT":
        registry.setHeartbeat(conn.nodeId, msg.payload);
        return;
      case "STATUS_UPDATE": {
        const error = tasks.handleStatus(conn.nodeId, msg.payload);
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      default:
        // Git flow, dependency and prompt handling land in later phases.
        log.debug(`${msg.type} from ${conn.nodeId}`, msg.payload);
    }
  };

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      targetDir: opts.targetDir,
      connections: connections.size,
      uptimeSec: Math.round(process.uptime()),
    }),
  );

  app.get("/api/nodes", (c) => c.json(registry.list()));

  app.get("/api/tasks", (c) => c.json(tasks.list()));

  app.get("/api/tasks/:id", (c) => {
    const task = tasks.get(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/tasks", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    try {
      return c.json(tasks.submit(body), 201);
    } catch (err) {
      if (err instanceof TaskError) return c.json({ error: err.message }, err.code === "duplicate" ? 409 : 400);
      throw err;
    }
  });

  app.get(
    WS_PATH,
    upgradeWebSocket(() => {
      const connId = randomUUID();
      let conn: Connection;
      return {
        onOpen(_evt, ws) {
          conn = { connId, ws };
          connections.set(connId, conn);
          log.info(`connection opened ${connId} (total ${connections.size})`);
        },
        onMessage(evt) {
          if (typeof evt.data !== "string") return reject(conn, "binary frames are not supported");
          if (Buffer.byteLength(evt.data) > MAX_FRAME_BYTES) return reject(conn, "frame too large");
          const parsed = parseAgentMessage(evt.data);
          if (!parsed.ok) return reject(conn, parsed.reason, parsed.issues, parsed.refId);
          handleMessage(conn, parsed.message);
        },
        onClose() {
          connections.delete(connId);
          if (conn?.nodeId && conn.transport) dropNode(conn.nodeId, conn.transport);
          log.info(`connection closed ${conn?.nodeId ?? connId} (total ${connections.size})`);
        },
        onError(evt) {
          log.warn(`socket error on ${connId}`, evt);
        },
      };
    }),
  );

  const server: ServerType = await new Promise((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(s));
    s.once("error", reject);
  });
  injectWebSocket(server);
  log.info(`listening on ${host}:${port} (ws path ${WS_PATH}), target ${opts.targetDir}`);

  // Half-open TCP connections (sleeping laptops, pulled cables) never fire onClose on their own.
  const sweep = setInterval(() => {
    for (const node of registry.stale(nodeTimeoutMs)) {
      log.warn(`node ${node.nodeId} timed out`);
      dropNode(node.nodeId, node.transport);
      node.transport.close(4008, "heartbeat timeout");
      // Live-but-slow peers get the close frame; dead peers are cut off after a grace period.
      setTimeout(() => node.transport.terminate(), 2000).unref();
    }
  }, Math.min(15_000, nodeTimeoutMs));
  sweep.unref();

  return {
    port,
    registry,
    tasks,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweep);
        for (const c of connections.values()) c.ws.close(1001, "hub shutting down");
        server.close(() => resolve());
      }),
  };
}
