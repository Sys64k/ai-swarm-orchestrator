import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  HUB_TO_NODE_TYPES,
  WORKER_ROLES,
  createLogger,
  createMessage,
  parseAgentMessage,
  resolveHubUrl,
  type AgentMessageType,
  type HardwareProfile,
  type PayloadInput,
  type WorkerRole,
} from "@aso/shared";
import { profileHardware } from "./hardware.js";

const log = createLogger("worker");

export interface WorkerOptions {
  /** Hub address: IP, host:port, or ws:// URL. */
  hub: string;
  port?: number;
  /** Agent roles this node accepts tasks for. Defaults to all worker roles. */
  roles?: WorkerRole[];
}

export interface WorkerHandle {
  nodeId: string;
  profile: HardwareProfile;
  stop(): void;
}

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const url = resolveHubUrl(opts.hub, opts.port);
  const roles = opts.roles?.length ? opts.roles : [...WORKER_ROLES];

  log.info("scanning hardware...");
  const profile = await profileHardware();
  const nodeId = `${profile.hostname}-${randomUUID().slice(0, 8)}`;
  log.info(
    `${profile.hostname}: ${profile.cpu.logicalCores} threads, ` +
      `${(profile.memory.totalBytes / 1024 ** 3).toFixed(1)} GiB RAM, ` +
      `docker ${profile.docker.available ? profile.docker.version : "unavailable"}`,
  );

  let ws: WebSocket | undefined;
  let attempt = 0;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | undefined;

  const send = <T extends AgentMessageType>(socket: WebSocket, type: T, payload: PayloadInput<T>) => {
    socket.send(JSON.stringify(createMessage(type, nodeId, payload)));
  };

  const connect = () => {
    const socket = new WebSocket(url);
    ws = socket;
    socket.on("open", () => {
      attempt = 0;
      log.info(`connected to hub ${url.href}`);
      send(socket, "NODE_REGISTRATION", {
        nodeKind: "worker",
        version: "0.1.0",
        roles,
        hardware: profile,
      });
    });
    socket.on("message", (data) => {
      const parsed = parseAgentMessage(data.toString());
      if (!parsed.ok) return log.warn(`invalid message from hub: ${parsed.reason}`, parsed.issues);
      const msg = parsed.message;
      if (!HUB_TO_NODE_TYPES.has(msg.type)) return log.warn(`unexpected ${msg.type} from hub`);
      switch (msg.type) {
        case "REGISTRATION_ACK":
          log.info(`registered as ${msg.payload.nodeId} (roles: ${roles.join(", ")})`);
          break;
        case "PROTOCOL_ERROR":
          log.error(`hub rejected message: ${msg.payload.reason}`, msg.payload.issues);
          break;
        default:
          // Task execution is wired up with routing and the Git flow in later phases.
          log.debug(`${msg.type} received`, msg.payload);
      }
    });
    socket.on("close", () => {
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      log.warn(`disconnected from hub, retrying in ${delay}ms`);
      retryTimer = setTimeout(connect, delay);
    });
    socket.on("error", (err) => log.debug(`socket error: ${err.message}`));
  };

  connect();

  return {
    nodeId,
    profile,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      ws?.close(1000, "worker stopping");
    },
  };
}
