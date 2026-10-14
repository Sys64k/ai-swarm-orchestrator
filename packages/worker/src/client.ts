import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  HEARTBEAT_INTERVAL_MS,
  HUB_TO_NODE_TYPES,
  WORKER_ROLES,
  authorizationHeader,
  createLogger,
  createMessage,
  hubGitUrl,
  parseAgentMessage,
  resolveHubUrl,
  type AgentMessageType,
  type HardwareProfile,
  type PayloadInput,
  type WorkerRole,
} from "@aso/shared";
import { profileHardware, sampleLoad } from "./hardware.js";
import { LlmTaskExecutor } from "./agent/executor.js";
import { JobRunner, type TaskExecutor } from "./jobs.js";
import { DockerSandbox, hostRunner, type CommandRunner, type DockerSandboxOptions } from "./sandbox.js";

const log = createLogger("worker");

export interface WorkerOptions {
  /** Hub address: IP, host:port, or ws:// URL. */
  hub: string;
  port?: number;
  /** Agent roles this node accepts tasks for. Defaults to all worker roles. */
  roles?: WorkerRole[];
  /** Directory for task checkouts; also where the I/O benchmark runs. Default ~/.aso/work. */
  workDir?: string;
  /** Does the implementation work. Defaults to the LLM agent (model calls go through the Hub). */
  executor?: TaskExecutor;
  /** Skip the hardware scan and use this profile (tests). */
  hardware?: HardwareProfile;
  nodeId?: string;
  /** Shared ASO token (required unless the Hub runs without authentication). */
  token?: string;
  /**
   * Where job commands run. `docker` (default): a throwaway container per command that sees
   * only the task checkout. `none`: directly on this machine, as this user. A ready-made
   * CommandRunner can be passed instead (tests).
   */
  sandbox?: "docker" | "none" | CommandRunner;
  /** Options for the Docker sandbox (image, network, cache). */
  sandboxOptions?: Omit<DockerSandboxOptions, "workDir">;
}

export const DEFAULT_WORK_DIR = path.join(os.homedir(), ".aso", "work");

/** Messages produced while disconnected are held (bounded) and sent after re-registration. */
const OUTBOX_LIMIT = 200;

export interface WorkerHandle {
  nodeId: string;
  profile: HardwareProfile;
  runner: JobRunner;
  stop(): void;
}

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const url = resolveHubUrl(opts.hub, opts.port);
  const roles = opts.roles?.length ? opts.roles : [...WORKER_ROLES];
  const workDir = path.resolve(opts.workDir ?? DEFAULT_WORK_DIR);

  let profile = opts.hardware;
  if (!profile) {
    log.info("scanning hardware...");
    profile = await profileHardware(workDir);
  }
  const commands = await createCommandRunner(opts.sandbox ?? "docker", workDir, opts.sandboxOptions);
  const nodeId = opts.nodeId ?? `${profile.hostname}-${randomUUID().slice(0, 8)}`;
  log.info(
    `${profile.hostname}: ${profile.cpu.logicalCores} threads, ` +
      `${(profile.memory.totalBytes / 1024 ** 3).toFixed(1)} GiB RAM, ` +
      `docker ${profile.docker.available ? (profile.docker.version ?? "available") : "unavailable"}, ` +
      `work dir ${workDir} @ ${profile.storage.writeMBps} MB/s`,
  );

  let ws: WebSocket | undefined;
  let registered = false;
  let attempt = 0;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const outbox: string[] = [];

  const transmit = (raw: string) => {
    if (ws && registered && ws.readyState === WebSocket.OPEN) return ws.send(raw);
    if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
    outbox.push(raw);
  };
  const send = <T extends AgentMessageType>(type: T, payload: PayloadInput<T>) =>
    transmit(JSON.stringify(createMessage(type, nodeId, payload)));

  const runner = new JobRunner({
    workDir,
    gitUrl: (project) => hubGitUrl(url, project),
    nodeId,
    executor: opts.executor ?? new LlmTaskExecutor(),
    send,
    token: opts.token,
    commands,
  });

  const connect = () => {
    const socket = new WebSocket(url, { headers: opts.token ? { authorization: authorizationHeader(opts.token) } : {} });
    ws = socket;
    registered = false;
    socket.on("open", () => {
      attempt = 0;
      log.info(`connected to hub ${url.href}`);
      socket.send(
        JSON.stringify(
          createMessage("NODE_REGISTRATION", nodeId, {
            nodeKind: "worker",
            version: "0.1.0",
            roles,
            hardware: profile,
            resume: runner.current,
          }),
        ),
      );
    });
    socket.on("message", (data) => {
      const parsed = parseAgentMessage(data.toString());
      if (!parsed.ok) return log.warn(`invalid message from hub: ${parsed.reason}`, parsed.issues);
      const msg = parsed.message;
      if (!HUB_TO_NODE_TYPES.has(msg.type)) return log.warn(`unexpected ${msg.type} from hub`);
      switch (msg.type) {
        case "REGISTRATION_ACK":
          registered = true;
          log.info(`registered as ${msg.payload.nodeId} (roles: ${roles.join(", ")})`);
          for (const raw of outbox.splice(0)) socket.send(raw);
          runner.resendPending();
          clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            sampleLoad()
              .then((load) => send("NODE_HEARTBEAT", load))
              .catch((err: Error) => log.warn(`heartbeat failed: ${err.message}`));
          }, HEARTBEAT_INTERVAL_MS);
          break;
        case "TASK_ASSIGNMENT":
          log.info(
            `assigned ${msg.payload.kind} task ${msg.payload.taskId}: ${msg.payload.title}` +
              (msg.payload.rework ? ` (rework round ${msg.payload.rework.round})` : ""),
          );
          send("STATUS_UPDATE", { state: "accepted", taskId: msg.payload.taskId });
          runner.enqueueTask(msg.payload);
          break;
        case "TEST_EXECUTION":
          log.info(`QA run for ${msg.payload.taskId} @ ${msg.payload.commit.slice(0, 8)}`);
          send("STATUS_UPDATE", { state: "accepted", taskId: msg.payload.taskId });
          runner.enqueueTest(msg.payload);
          break;
        case "PROMPT_RESULT":
          runner.handlePromptResult(msg.payload);
          break;
        case "DEPENDENCY_RESPONSE":
          runner.handleDependencyResponse(msg.payload);
          break;
        case "PROTOCOL_ERROR":
          log.error(`hub rejected message: ${msg.payload.reason}`, msg.payload.issues);
          break;
        default:
          log.debug(`${msg.type} received`, msg.payload);
      }
    });
    socket.on("close", () => {
      registered = false;
      clearInterval(heartbeatTimer);
      if (stopped) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempt++);
      log.warn(`disconnected from hub, retrying in ${delay}ms`);
      retryTimer = setTimeout(connect, delay);
    });
    socket.on("unexpected-response", (_req, res) => {
      // 401 means the token is wrong; retrying won't help, but keep trying in case it's fixed on the Hub.
      log.error(`hub refused the connection: HTTP ${res.statusCode}${res.statusCode === 401 ? " (check ASO_TOKEN)" : ""}`);
      socket.terminate();
    });
    socket.on("error", (err) => log.debug(`socket error: ${err.message}`));
  };

  connect();

  return {
    nodeId,
    profile,
    runner,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(heartbeatTimer);
      ws?.close(1000, "worker stopping");
    },
  };
}

async function createCommandRunner(
  sandbox: NonNullable<WorkerOptions["sandbox"]>,
  workDir: string,
  options: WorkerOptions["sandboxOptions"],
): Promise<CommandRunner> {
  if (typeof sandbox === "object") return sandbox;
  if (sandbox === "none") {
    log.warn("sandbox disabled: agent commands, npm install scripts and tests run directly on this machine as this user");
    return hostRunner;
  }
  const docker = new DockerSandbox({ ...options, workDir });
  await docker.prepare();
  return docker;
}
