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
  hubGitUrl,
  parseAgentMessage,
  resolveHubUrl,
  type AgentMessageType,
  type HardwareProfile,
  type PayloadInput,
  type Supervisor,
  UNKNOWN_VERSION,
} from "@aso/shared";
import { profileHardware, resolveSlots, sampleLoad } from "./hardware.js";
import { LlmTaskExecutor } from "./agent/executor.js";
import { JobRunner, type RunningJob, type TaskExecutor } from "./jobs.js";
import { DockerSandbox, hostRunner, type CommandRunner, type DockerSandboxOptions } from "./sandbox.js";
import { lockWorkDir } from "./work-dir-lock.js";

const log = createLogger("worker");

export interface WorkerOptions {
  /** Hub address: IP, host:port, or ws:// URL. */
  hub: string;
  port?: number;
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
  /** The aso build this worker runs (`0.1.0+<commit>`), shown on the Hub so outdated workers stand out. */
  version?: string;
  /** Jobs to run at once, each in its own checkout. Default: `defaultSlots` for this machine. */
  slots?: number;
  /** The service manager that starts this worker again after it exits; lets the console restart it. */
  supervisor?: Supervisor;
  /** Called when the Hub asks for a restart, once no job runs: stop and exit (the CLI does). */
  onRestart?: () => void;
  /**
   * Called when the Hub asks for an update, once no job runs: install the build the Hub serves,
   * then stop and exit for the service manager to start it (the CLI does, for a package install
   * run as a service). Rejects when the install fails: the worker reports it and carries on.
   * When set, the worker tells the Hub it can update itself.
   */
  onUpdate?: (version: string) => Promise<void>;
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
  const workDir = path.resolve(opts.workDir ?? DEFAULT_WORK_DIR);
  const lock = lockWorkDir(workDir);

  let profile = opts.hardware;
  let commands: CommandRunner;
  try {
    if (!profile) {
      log.info("scanning hardware...");
      profile = await profileHardware(workDir);
    }
    commands = await createCommandRunner(opts.sandbox ?? "docker", workDir, opts.sandboxOptions);
  } catch (err) {
    lock.release();
    throw err;
  }
  const nodeId = opts.nodeId ?? `${profile.hostname}-${randomUUID().slice(0, 8)}`;
  const slots = resolveSlots(opts.slots, profile, typeof opts.sandbox === "object" ? "custom" : (opts.sandbox ?? "docker"));
  log.info(
    `${profile.hostname}: ${profile.cpu.logicalCores} threads, ` +
      `${(profile.memory.totalBytes / 1024 ** 3).toFixed(1)} GiB RAM, ` +
      `docker ${profile.docker.available ? (profile.docker.version ?? "available") : "unavailable"}, ` +
      `work dir ${workDir} @ ${profile.storage.writeMBps} MB/s, ${slots} job slot${slots === 1 ? "" : "s"}`,
  );

  let ws: WebSocket | undefined;
  let registered = false;
  let attempt = 0;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  /** Last Docker state logged, so a heartbeat logs only a change. */
  let dockerAvailable = profile.docker.available;
  /** Held while disconnected; `final` marks a job's result (see `Send`). */
  const outbox: Array<{ raw: string; final?: RunningJob }> = [];

  const transmit = (raw: string, final?: RunningJob) => {
    if (ws && registered && ws.readyState === WebSocket.OPEN) return ws.send(raw);
    if (outbox.length >= OUTBOX_LIMIT) outbox.shift();
    outbox.push({ raw, final });
  };
  const send = <T extends AgentMessageType>(type: T, payload: PayloadInput<T>, final?: RunningJob) =>
    transmit(JSON.stringify(createMessage(type, nodeId, payload)), final);
  /** Jobs to claim when registering: running ones, and finished ones whose result is still held. */
  const claims = (): RunningJob[] => {
    const held = outbox.flatMap((m) => (m.final ? [m.final] : []));
    const all = [...runner.running, ...held];
    return all.filter((j, i) => all.findIndex((k) => k.taskId === j.taskId && k.job === j.job) === i);
  };

  const runner = new JobRunner({
    workDir,
    gitUrl: (project) => hubGitUrl(url, project),
    nodeId,
    executor: opts.executor ?? new LlmTaskExecutor(),
    send,
    token: opts.token,
    commands,
    slots,
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
            version: opts.version ?? UNKNOWN_VERSION,
            supervisor: opts.supervisor,
            updates: opts.onUpdate ? "package" : undefined,
            hardware: profile,
            slots,
            running: claims(),
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
          log.info(`registered as ${msg.payload.nodeId}`);
          for (const { raw } of outbox.splice(0)) socket.send(raw);
          runner.resendPending();
          clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            sampleLoad()
              .then(({ load, dockerError }) => {
                if (load.dockerAvailable !== dockerAvailable) {
                  if (dockerError) log.warn(`Docker is not available: ${dockerError}`);
                  else log.info("Docker is available now");
                  dockerAvailable = load.dockerAvailable;
                }
                send("NODE_HEARTBEAT", load);
              })
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
        case "NODE_CONTROL":
          if (msg.payload.action === "update") update(msg.payload.version);
          else restart();
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

  /**
   * Run a restart or update once no job runs. The Hub only asks while no job runs, but a job's last messages may still be on their way:
   * check every second until the runner is empty. A repeated request joins the waiting one.
   */
  const whenIdle = (action: () => void | Promise<void>) => {
    if (idleTimer) return;
    const check = () => {
      if (stopped) return;
      if (!runner.isIdle) {
        idleTimer = setTimeout(check, 1000);
        return;
      }
      // A restart or update that worked exits the process. One that failed leaves the worker
      // running, so a later request must not be taken for this one.
      Promise.resolve(action()).catch(() => (idleTimer = undefined));
    };
    idleTimer = setTimeout(check, 0);
  };

  const restart = () => {
    if (!opts.onRestart) return log.warn("the Hub asked for a restart, but this worker has no service to start it again; ignoring");
    log.info("restart requested from the console");
    whenIdle(opts.onRestart);
  };

  /** Install the build the Hub serves and exit; on failure tell the Hub, which gives this worker jobs again. */
  const update = (version: string) => {
    const { onUpdate } = opts;
    if (!onUpdate) {
      log.warn(`the Hub asked for an update to ${version}, but this worker cannot update itself; run aso update`);
      send("UPDATE_FAILED", { version, reason: "this worker cannot update itself; run aso update on it" });
      return;
    }
    log.info(`updating to ${version}, as the Hub asks`);
    whenIdle(() =>
      onUpdate(version).catch((err: Error) => {
        log.error(`update to ${version} failed: ${err.message}`);
        send("UPDATE_FAILED", { version, reason: err.message.slice(0, 2000) || "unknown error" });
        throw err;
      }),
    );
  };

  connect();

  return {
    nodeId,
    profile,
    runner,
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearTimeout(idleTimer);
      clearInterval(heartbeatTimer);
      ws?.close(1000, "worker stopping");
      lock.release();
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
