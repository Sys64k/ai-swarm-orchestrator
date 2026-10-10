import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  HEARTBEAT_INTERVAL_MS,
  HUB_TO_NODE_TYPES,
  authorizationHeader,
  createLogger,
  createMessage,
  parseAgentMessage,
  resolveHubUrl,
  type AgentMessageType,
  type PayloadInput,
} from "@aso/shared";
import { ModelChannel } from "@aso/worker";
import { Planner } from "./planner.js";

const log = createLogger("architect");

export interface ArchitectOptions {
  hub: string;
  port?: number;
  /** Read-only checkout for exploring the project. Default ~/.aso/architect. */
  workDir?: string;
  nodeId?: string;
  retryDelaysMs?: number[];
  /** Shared ASO token (required unless the Hub runs without authentication). */
  token?: string;
}

export interface ArchitectHandle {
  nodeId: string;
  /** Resolves when queued planning runs are done. */
  idle(): Promise<void>;
  stop(): void;
}

const OUTBOX_LIMIT = 200;

/** The Architect node: registers with the Hub and turns PLAN_REQUESTs into proposed plans. */
export function startArchitect(opts: ArchitectOptions): ArchitectHandle {
  const url = resolveHubUrl(opts.hub, opts.port);
  const nodeId = opts.nodeId ?? `architect-${randomUUID().slice(0, 8)}`;
  const workDir = path.resolve(opts.workDir ?? path.join(os.homedir(), ".aso", "architect"));

  let ws: WebSocket | undefined;
  let registered = false;
  let attempt = 0;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  const outbox: string[] = [];
  /** Plans already answered: a requeued duplicate request after a reconnect is answered again, not re-planned. */
  const answered = new Map<string, PayloadInput<"PLAN_RESULT">>();
  let queue: Promise<void> = Promise.resolve();

  const send = <T extends AgentMessageType>(type: T, payload: PayloadInput<T>) => {
    const raw = JSON.stringify(createMessage(type, nodeId, payload));
    if (ws && registered && ws.readyState === WebSocket.OPEN) return ws.send(raw);
    if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
    outbox.push(raw);
  };
  const model = new ModelChannel(send);
  const planner = new Planner({ hubUrl: url, workDir, model, retryDelaysMs: opts.retryDelaysMs, token: opts.token });

  const connect = () => {
    const socket = new WebSocket(url, { headers: opts.token ? { authorization: authorizationHeader(opts.token) } : {} });
    ws = socket;
    registered = false;
    socket.on("open", () => {
      attempt = 0;
      socket.send(JSON.stringify(createMessage("NODE_REGISTRATION", nodeId, { nodeKind: "architect", version: "0.1.0" })));
    });
    socket.on("message", (data) => {
      const parsed = parseAgentMessage(data.toString());
      if (!parsed.ok) return log.warn(`invalid message from hub: ${parsed.reason}`, parsed.issues);
      const msg = parsed.message;
      if (!HUB_TO_NODE_TYPES.has(msg.type)) return;
      switch (msg.type) {
        case "REGISTRATION_ACK":
          registered = true;
          log.info(`registered as ${nodeId} with ${url.href}`);
          for (const raw of outbox.splice(0)) socket.send(raw);
          model.resendPending();
          clearInterval(keepalive);
          // No load metrics to report; an idle status keeps the Hub's liveness check satisfied.
          keepalive = setInterval(() => send("STATUS_UPDATE", { state: "idle" }), HEARTBEAT_INTERVAL_MS);
          break;
        case "PLAN_REQUEST": {
          const { planId } = msg.payload;
          log.info(`planning ${planId}`);
          queue = queue.then(async () => {
            const result = answered.get(planId) ?? (await planner.plan(planId));
            answered.set(planId, result);
            send("PLAN_RESULT", result);
          });
          break;
        }
        case "PROMPT_RESULT":
          model.handleResult(msg.payload);
          break;
        case "PROTOCOL_ERROR":
          log.error(`hub rejected message: ${msg.payload.reason}`, msg.payload.issues);
          break;
      }
    });
    socket.on("close", () => {
      registered = false;
      clearInterval(keepalive);
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      log.warn(`disconnected from hub, retrying in ${delay}ms`);
      retryTimer = setTimeout(connect, delay);
    });
    socket.on("unexpected-response", (_req, res) => {
      log.error(`hub refused the connection: HTTP ${res.statusCode}${res.statusCode === 401 ? " (check ASO_TOKEN)" : ""}`);
      socket.terminate();
    });
    socket.on("error", (err) => log.debug(`socket error: ${err.message}`));
  };
  connect();

  return {
    nodeId,
    idle: () => queue,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(keepalive);
      ws?.close(1000, "architect stopping");
    },
  };
}
