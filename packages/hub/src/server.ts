import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import {
  DEFAULT_HUB_PORT,
  HUB_NODE_ID,
  NODE_TO_HUB_TYPES,
  WS_PATH,
  createLogger,
  createMessage,
  parseAgentMessage,
  type AgentMessage,
  type AgentMessageType,
  type MessageOf,
  type PayloadInput,
} from "@aso/shared";

const log = createLogger("hub");

/** Frames larger than this are rejected before parsing. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface HubOptions {
  /** Absolute path to the target project repository the swarm operates on. */
  targetDir: string;
  port?: number;
  host?: string;
}

export interface HubHandle {
  port: number;
  close(): Promise<void>;
}

type Registration = MessageOf<"NODE_REGISTRATION">["payload"];

interface Connection {
  connId: string;
  ws: WSContext;
  connectedAt: Date;
  /** Set once the node has sent a valid NODE_REGISTRATION. */
  nodeId?: string;
  registration?: Registration;
}

export async function startHub(opts: HubOptions): Promise<HubHandle> {
  const port = opts.port ?? DEFAULT_HUB_PORT;
  const host = opts.host ?? "0.0.0.0";
  const connections = new Map<string, Connection>();
  const nodes = new Map<string, Connection>();

  const send = <T extends AgentMessageType>(conn: Connection, type: T, payload: PayloadInput<T>) => {
    conn.ws.send(JSON.stringify(createMessage(type, HUB_NODE_ID, payload)));
  };

  const reject = (conn: Connection, reason: string, issues: string[] = [], refId?: string) => {
    log.warn(`rejected message from ${conn.nodeId ?? conn.connId}: ${reason}`, issues.length ? issues : undefined);
    send(conn, "PROTOCOL_ERROR", { reason, issues, refId });
  };

  const handleMessage = (conn: Connection, msg: AgentMessage) => {
    if (!NODE_TO_HUB_TYPES.has(msg.type)) {
      return reject(conn, `nodes may not send ${msg.type}`, [], msg.id);
    }

    if (msg.type === "NODE_REGISTRATION") {
      if (conn.nodeId) return reject(conn, "already registered", [], msg.id);
      if (msg.from === HUB_NODE_ID || nodes.has(msg.from)) {
        reject(conn, `node id "${msg.from}" is already in use`, [], msg.id);
        return conn.ws.close(4009, "duplicate node id");
      }
      conn.nodeId = msg.from;
      conn.registration = msg.payload;
      nodes.set(msg.from, conn);
      const p = msg.payload;
      log.info(
        p.nodeKind === "worker"
          ? `worker ${msg.from} registered from ${p.hardware.hostname} (roles: ${p.roles.join(", ")})`
          : `architect ${msg.from} registered`,
      );
      return send(conn, "REGISTRATION_ACK", { nodeId: msg.from });
    }

    if (!conn.nodeId) return reject(conn, "NODE_REGISTRATION required first", [], msg.id);
    if (msg.from !== conn.nodeId) {
      return reject(conn, `envelope from "${msg.from}" does not match registered node`, [], msg.id);
    }

    // Routing for tasks, dependencies and prompts lands in later phases.
    log.debug(`${msg.type} from ${conn.nodeId}`, msg.payload);
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

  app.get("/api/nodes", (c) =>
    c.json(
      [...nodes.values()].map((n) => ({
        nodeId: n.nodeId,
        connectedAt: n.connectedAt.toISOString(),
        ...n.registration,
      })),
    ),
  );

  app.get(
    WS_PATH,
    upgradeWebSocket(() => {
      const connId = randomUUID();
      let conn: Connection;
      return {
        onOpen(_evt, ws) {
          conn = { connId, ws, connectedAt: new Date() };
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
          if (conn?.nodeId && nodes.get(conn.nodeId) === conn) nodes.delete(conn.nodeId);
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

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of connections.values()) c.ws.close(1001, "hub shutting down");
        server.close(() => resolve());
      }),
  };
}
