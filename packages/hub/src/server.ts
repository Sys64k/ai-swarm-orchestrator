import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import {
  DEFAULT_HUB_PORT,
  GIT_PATH,
  HUB_NODE_ID,
  NODE_TIMEOUT_MS,
  NODE_TO_HUB_TYPES,
  WS_PATH,
  createLogger,
  createMessage,
  isAuthorized,
  parseAgentMessage,
  type AgentMessage,
} from "@aso/shared";
import { DependencyManager } from "./dependencies.js";
import { AnthropicApiAdapter, type Effort, type LlmAdapter } from "./llm/adapter.js";
import { ConversationManager } from "./llm/conversations.js";
import { hasPrice } from "./llm/pricing.js";
import { gitHttpHandler } from "./git/http-backend.js";
import { HubRepository, type DependencyInstaller } from "./git/hub-repo.js";
import { GitSync } from "./git/sync.js";
import { PlanError, PlanManager } from "./plans.js";
import { NodeRegistry, type NodeTransport } from "./registry.js";
import type { RoutingPolicies } from "./routing.js";
import { StateStore } from "./state-store.js";
import { TaskError, TaskManager, type QaOptions, type TaskRecord } from "./tasks.js";
import type { PlanRecord } from "./plans.js";

const log = createLogger("hub");

/** Frames larger than this are rejected before parsing. */
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface HubOptions {
  /** Absolute path to the target project repository the swarm operates on. */
  targetDir: string;
  /**
   * Where tasks, plans and agent conversations are saved so they survive a restart.
   * Default: `<targetDir>/.git/aso`, which keeps the state with the project it belongs to.
   * `null` keeps everything in memory only.
   */
  stateDir?: string | null;
  port?: number;
  host?: string;
  policies?: RoutingPolicies;
  /** Drop nodes silent for longer than this. */
  nodeTimeoutMs?: number;
  /** How long a started job waits for its disconnected node before being reassigned. */
  reclaimGraceMs?: number;
  qa?: Partial<QaOptions>;
  mainBranch?: string;
  /** Package names (or `@scope/*`) agents may request; undefined allows any. */
  allowDependencies?: readonly string[];
  /** Replaces the npm-based installer (tests). */
  dependencyInstaller?: DependencyInstaller;
  /**
   * Shared secret required on the WebSocket, API and Git endpoints. `null` disables
   * authentication (only for tests and fully trusted setups); the CLI always sets one.
   */
  token: string | null;
  /** The `aso` package this Hub serves to other machines (`aso update`, first installs). */
  dist?: { version: () => string | undefined; tarball: () => string | undefined };
  /** Push main to the target repo's remote after merges. Default: on when an `origin` remote exists. */
  sync?: { enabled?: boolean; remote?: string; token?: string; retryMs?: number };
  llm?: {
    /** Defaults to the Anthropic API adapter when ANTHROPIC_API_KEY is set; otherwise no LLM. */
    adapter?: LlmAdapter;
    model?: string;
    effort?: Effort;
    maxTokens?: number;
    taskBudgetUsd?: number;
    planBudgetUsd?: number;
    maxTurns?: number;
    concurrency?: number;
  };
}

export interface HubHandle {
  port: number;
  registry: NodeRegistry;
  tasks: TaskManager;
  plans: PlanManager;
  repo: HubRepository;
  sync: GitSync;
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
  const repo = await HubRepository.open(opts.targetDir, opts.mainBranch);
  const registry = new NodeRegistry();
  const stateDir = opts.stateDir === undefined ? path.join(await repo.gitDir(), "aso") : opts.stateDir;
  const store = stateDir === null ? undefined : new StateStore(stateDir);
  const saved = await store?.load<TaskRecord, PlanRecord>();
  const persist = () => store?.scheduleSave(() => ({ tasks: tasks.list(), plans: plans.list() }));
  const sync = await GitSync.create(repo, {
    enabled: opts.sync?.enabled ?? true,
    remote: opts.sync?.remote,
    token: opts.sync?.token,
    retryMs: opts.sync?.retryMs,
  });
  /** Merged tasks waiting for their commits to reach the remote. */
  const unpushed = new Set<string>();
  const tasks = new TaskManager(registry, repo, {
    onMerged: (task) => {
      if (!sync.status().enabled) return;
      unpushed.add(task.spec.taskId);
      void sync.requestPush();
    },
    onChange: persist,
    policies: opts.policies,
    reclaimGraceMs: opts.reclaimGraceMs,
    qa: opts.qa,
  });
  const llm = opts.llm ?? {};
  const model = llm.model ?? "claude-opus-5-5";
  const adapter =
    llm.adapter ??
    (process.env.ANTHROPIC_API_KEY
      ? new AnthropicApiAdapter({ model, effort: llm.effort ?? "high", maxTokens: llm.maxTokens ?? 32_000 })
      : undefined);
  if (!adapter) log.warn("no LLM configured: set ANTHROPIC_API_KEY to let agents work");
  else {
    log.info(`LLM: ${adapter.name} ${adapter.model}`);
    if (!hasPrice(adapter.model)) log.warn(`no price known for ${adapter.model}; cost estimates will read $0`);
  }
  sync.onResult((r) => {
    for (const id of unpushed) {
      tasks.recordEvent(id, r.ok ? `pushed to ${sync.status().remote} (${r.commit!.slice(0, 8)})` : `push to ${sync.status().remote} failed: ${r.error}`);
    }
    if (r.ok) unpushed.clear();
  });
  const plans = new PlanManager(registry, tasks, persist);
  if (saved) {
    tasks.restore(saved.tasks);
    plans.restore(saved.plans);
  }
  const conversations = new ConversationManager(adapter, tasks, registry, plans, {
    taskBudgetUsd: llm.taskBudgetUsd,
    planBudgetUsd: llm.planBudgetUsd,
    maxTurns: llm.maxTurns,
    concurrency: llm.concurrency,
    store,
  });
  await conversations.restore();
  if (store) log.info(`Hub state is saved in ${store.dir}`);
  const deps = new DependencyManager(repo, tasks, registry, {
    installer: opts.dependencyInstaller,
    allow: opts.allowDependencies,
  });

  /** Idempotent: safe to call from both the timeout sweep and the socket close event. */
  const dropNode = (nodeId: string, transport: NodeTransport) => {
    if (!registry.unregister(nodeId, transport)) return;
    tasks.handleNodeGone(nodeId);
    plans.handleNodeGone(nodeId);
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
      tasks.nodeRegistered(msg.from, p.nodeKind === "worker" ? p.resume : undefined);
      plans.dispatch();
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
      case "DEPENDENCY_REQUEST": {
        const error = deps.handle(conn.nodeId, msg.payload);
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "PROMPT_EXECUTION": {
        const error = conversations.handle(conn.nodeId, msg.payload);
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "FILE_OPERATION": {
        const error = tasks.recordFileOperation(conn.nodeId, msg.payload);
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "PLAN_RESULT": {
        const error = plans.handleResult(conn.nodeId, msg.payload);
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "FEEDBACK_LOOP": {
        const error = tasks.handleFeedback(conn.nodeId, msg.payload);
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

  if (opts.token === undefined) throw new Error("startHub requires a token (or null to disable authentication)");
  const token = opts.token;
  if (token === null) log.warn("authentication is DISABLED: anyone who can reach this Hub can control it");
  const requireAuth: MiddlewareHandler = async (c, next) => {
    if (token === null || isAuthorized(c.req.header("authorization"), token)) return next();
    c.header("WWW-Authenticate", 'Basic realm="ASO Hub"');
    return c.json({ error: "missing or invalid ASO token" }, 401);
  };
  // The CLI package is public: it contains no secrets, and new machines need it before they
  // have a token. Version info lets `aso update` decide whether to download it.
  let digest: { file: string; mtimeMs: number; sha256: string } | undefined;
  const packageSha256 = async (file: string) => {
    const { mtimeMs } = await stat(file);
    if (digest?.file !== file || digest.mtimeMs !== mtimeMs) {
      digest = { file, mtimeMs, sha256: createHash("sha256").update(await readFile(file)).digest("hex") };
    }
    return digest.sha256;
  };
  app.get("/api/version", async (c) => {
    const file = opts.dist?.tarball();
    return c.json({ version: (file && opts.dist?.version()) ?? null, package: !!file, sha256: file ? await packageSha256(file) : null });
  });
  app.get("/dist/aso.tgz", async (c) => {
    const file = opts.dist?.tarball();
    if (!file) return c.json({ error: "this Hub has no aso package to serve (run `npm run package` on it)" }, 404);
    const data = await readFile(file);
    return c.body(data, 200, {
      "content-type": "application/gzip",
      "content-disposition": 'attachment; filename="aso.tgz"',
    });
  });

  // Health stays public (minimal) so tools can check liveness; everything else needs the token.
  app.use("/api/*", async (c, next) => (["/api/health", "/api/version"].includes(c.req.path) ? next() : requireAuth(c, next)));
  app.use(`${GIT_PATH}/*`, requireAuth);
  app.use(WS_PATH, requireAuth);

  // Workers clone, fetch and push the target project here; pushes are limited to task/* refs.
  const git = gitHttpHandler(repo.dir);
  app.on(["GET", "POST"], [GIT_PATH, `${GIT_PATH}/*`], (c) => git(c));

  app.get("/api/health", (c) => {
    if (token !== null && !isAuthorized(c.req.header("authorization"), token)) return c.json({ status: "ok", auth: true });
    return c.json({
      status: "ok",
      auth: token !== null,
      targetDir: opts.targetDir,
      stateDir: store?.dir ?? null,
      mainBranch: repo.mainBranch,
      sync: sync.status(),
      qa: tasks.qa,
      allowDependencies: opts.allowDependencies ?? null,
      connections: connections.size,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.get("/api/nodes", (c) => c.json(registry.list()));

  app.get("/api/llm", (c) => c.json(conversations.status()));

  app.get("/api/sync", (c) => c.json(sync.status()));
  app.post("/api/sync", async (c) => {
    await sync.requestPush();
    return c.json(sync.status());
  });

  const planError = (c: Context, err: unknown) => {
    if (!(err instanceof PlanError)) throw err;
    const status = err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : 400;
    return c.json({ error: err.message }, status);
  };

  app.get("/api/plans", (c) => c.json(plans.list()));

  app.get("/api/plans/:id", (c) => {
    const plan = plans.get(c.req.param("id"));
    return plan ? c.json(plan) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/plans", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { requirement?: unknown } | null;
    try {
      return c.json(plans.create(body?.requirement), 201);
    } catch (err) {
      return planError(c, err);
    }
  });

  app.post("/api/plans/:id/approve", (c) => {
    try {
      return c.json(plans.approve(c.req.param("id")));
    } catch (err) {
      if (err instanceof TaskError) return c.json({ error: err.message }, 400);
      return planError(c, err);
    }
  });

  app.post("/api/plans/:id/reject", (c) => {
    try {
      return c.json(plans.reject(c.req.param("id")));
    } catch (err) {
      return planError(c, err);
    }
  });

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
  // Port 0 asks the OS for a free port; report the one actually bound.
  const boundPort = (server.address() as AddressInfo | null)?.port ?? port;
  log.info(`listening on ${host}:${boundPort} (ws ${WS_PATH}, git ${GIT_PATH}), target ${opts.targetDir}`);

  // Half-open TCP connections (sleeping laptops, pulled cables) never fire onClose on their own.
  const sweep = setInterval(() => {
    for (const node of registry.stale(nodeTimeoutMs)) {
      log.warn(`node ${node.nodeId} timed out`);
      dropNode(node.nodeId, node.transport);
      node.transport.close(4008, "heartbeat timeout");
      // Live-but-slow peers get the close frame; dead peers are cut off after a grace period.
      setTimeout(() => node.transport.terminate(), 2000).unref();
    }
    tasks.sweepDetached();
    conversations.sweep();
  }, Math.min(15_000, nodeTimeoutMs, opts.reclaimGraceMs ?? Infinity));
  sweep.unref();

  return {
    port: boundPort,
    registry,
    tasks,
    plans,
    repo,
    sync,
    close: async () => {
      clearInterval(sweep);
      sync.stop();
      // Save before the nodes are disconnected: those disconnects are the Hub's doing, and
      // restore() decides what happens to their jobs. Hub-side steps still running (a merge)
      // are saved mid-way and simply run again on the next start.
      await store?.close();
      for (const c of connections.values()) c.ws.close(1001, "hub shutting down");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
