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
  MAX_FRAME_BYTES,
  GIT_PATH,
  HUB_NODE_ID,
  NODE_TIMEOUT_MS,
  NODE_TO_HUB_TYPES,
  WS_PATH,
  UNKNOWN_VERSION,
  createLogger,
  createMessage,
  isAuthorized,
  credentialOf,
  JoinBodySchema,
  DiscoveryProofBodySchema,
  DeskAssignmentBodySchema,
  discoveryKeyId,
  discoveryProof,
  discoverySecret,
  JoinCodeBodySchema,
  parseAgentMessage,
  parseBody,
  runningJobsOf,
  PushEndpointSchema,
  PushSubscriptionSchema,
  PushTestSchema,
  ApproveTaskBodySchema,
  CreatePlanBodySchema,
  CreateProjectBodySchema,
  CreateTaskBodySchema,
  DeployResultBodySchema,
  HubUpdateReportBodySchema,
  type HubUpdate,
  PlanReplyBodySchema,
  RedeemSignInCodeBodySchema,
  RequestChangesBodySchema,
  SyncBodySchema,
  type AgentMessage,
} from "@aso/shared";
import { API_DOC_VERSION, openApiDocument } from "./api/openapi.js";
import { syncApiCopies } from "./api-sync.js";
import type { z } from "zod";
import { AnthropicApiAdapter, DEFAULT_MAX_TOKENS, type Effort, type LlmAdapter } from "./llm/adapter.js";
import { openAiCompatibleFor } from "./llm/openai-compatible.js";
import { adapterForModel, DeskModels, desksOf } from "./llm/desk-models.js";
import { ModelCatalog, resolveModel } from "./llm/catalog.js";
import { ConversationManager } from "./llm/conversations.js";
import { hasPrice } from "./llm/pricing.js";
import { gitHttpHandler } from "./git/http-backend.js";
import { type DependencyInstaller } from "./git/hub-repo.js";
import type { GitSync } from "./git/sync.js";
import { PlanError, type PlanRecord } from "./plans.js";
import { ProjectError, ProjectSet, type Project } from "./projects.js";
import { isOutdated, NodeError, NodeRegistry, type NodeEntry, type NodeTransport, type Registration } from "./registry.js";
import type { RoutingPolicies } from "./routing.js";
import { Notifier, TEST_NOTIFICATION } from "./push/notifier.js";
import { WorkerWatch } from "./push/workers.js";
import { Deployer, deployNotification, HostDeployQueue } from "./deploy.js";
import { hubUpdateNotification } from "./hub-update.js";
import { NodeOwners, nodeIdsInUse } from "./node-owners.js";
import { WorkerKeys, type WorkerKeyView } from "./worker-keys.js";

/** Wrong join codes per client address and minute before joining answers 429 (codes are 144 random bits; this only slows a flood). */
const MAX_FAILED_JOINS_PER_MIN = 30;
import type { sendPush } from "./push/web-push.js";
import { SignInCodes } from "./sign-in-codes.js";
import { StateStore } from "./state-store.js";
import { TaskError, type QaOptions, type TaskRecord } from "./tasks.js";

const log = createLogger("hub");

export interface HubOptions {
  /**
   * Folder of projects: every git repository directly inside it is a project (id = folder name),
   * and new projects are created there. Give this or `targetDir`.
   */
  projectsRoot?: string;
  /**
   * How to show `projectsRoot` to people: in Docker the Hub sees `/projects`, but the folder on
   * the host is what they'd look for (e.g. `/home/me/aso-projects`).
   */
  projectsRootDisplay?: string;
  /** A single project repository, served as project `project` (no projects can be created). */
  targetDir?: string;
  /**
   * Tasks, plans and transcripts are saved in each project's `.git/aso/`, and agent conversations
   * in `<projectsRoot>/.aso/` (or the single project's `.git/aso/`). `null` keeps everything in
   * memory only.
   */
  stateDir?: null;
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
  /**
   * Have outdated workers install the package this Hub serves and restart, once idle (only
   * workers that can: package installs run by `aso service install`). Default: on.
   */
  autoUpdate?: boolean;
  /** The `aso` package this Hub serves to other machines (`aso update`, first installs). */
  dist?: { version: () => string | undefined; tarball: () => string | undefined };
  /**
   * When the Hub starts, queue a task for each project whose copy of this Hub's API description
   * (`docs/openapi.json`) is out of date. Default: on.
   */
  apiSync?: boolean;
  /**
   * Push main to the target repo's remote after merges, and catch up with what was merged there
   * (`followMs`: see ProjectSetOptions). Default: on when an `origin` remote exists.
   */
  sync?: { enabled?: boolean; remote?: string; token?: string; retryMs?: number; followMs?: number };
  /**
   * QA-approved work as GitHub pull requests that a person merges, when the remote is on GitHub
   * and `sync.token` is set. Default on; `enabled: false` merges on the Hub instead.
   */
  pullRequests?: {
    enabled?: boolean;
    apiUrl?: string;
    repo?: { owner: string; repo: string };
    pollMs?: number;
    /** The console's address, for links from a pull request to its task. Default: ASO_CONSOLE_URL. */
    consoleUrl?: string;
    /** Where a connected GitHub repository's Git lives (tests); default its github.com URL. */
    gitUrl?: (slug: { owner: string; repo: string }) => string;
  };
  /** Push notifications. `send` replaces real delivery (tests); the contact defaults to ASO_PUSH_CONTACT. */
  /** `host`: a Hub in a container hands deploy commands to the `aso start-hub --docker` process on the host. */
  deploy?: { runner: "host"; /** Shorter waits (tests). */ queue?: { pickupMs?: number; graceMs?: number } };
  push?: {
    send?: typeof sendPush;
    contact?: string;
    /** How long a worker machine may be gone before the alert (tests). */
    workerOfflineMs?: number;
  };
  llm?: {
    /** Defaults to the Anthropic API adapter when ANTHROPIC_API_KEY is set; otherwise no LLM. */
    adapter?: LlmAdapter;
    /** The Architect's model, and the agents' unless `agentModel` is set. */
    model?: string;
    /** Task agents' model (builders, QA). `agentAdapter` replaces it in tests. */
    agentModel?: string;
    agentAdapter?: LlmAdapter;
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
  projects: ProjectSet;
  /** Tasks of all projects, by id. */
  tasks: ProjectSet["tasks"];
  /** Plans of all projects, by id. */
  plans: ProjectSet["plans"];
  /** Push status of the only project (single-project Hubs). */
  sync: GitSync;
  /** The HTTP routes it answers (method and path), to check them against the API description. */
  routes(): Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

interface Connection {
  connId: string;
  ws: WSContext;
  /** The worker key it connected with; none for the Hub's own token. */
  workerKey?: { id: string; name: string };
  /** Set once the node has sent a valid NODE_REGISTRATION. */
  nodeId?: string;
  transport?: NodeTransport;
}

export async function startHub(opts: HubOptions): Promise<HubHandle> {
  const port = opts.port ?? DEFAULT_HUB_PORT;
  const host = opts.host ?? "0.0.0.0";
  const nodeTimeoutMs = opts.nodeTimeoutMs ?? NODE_TIMEOUT_MS;
  const connections = new Map<string, Connection>();
  if (!opts.projectsRoot && !opts.targetDir) throw new Error("startHub needs projectsRoot or targetDir");
  const registry = new NodeRegistry();
  // Set once the Hub-wide state folder is known; changes made while projects load notify nobody.
  let notifier: Notifier | undefined;
  let deployer: Deployer | undefined;
  const hostDeploys = opts.deploy?.runner === "host" ? new HostDeployQueue(opts.deploy.queue) : undefined;
  const projects = await ProjectSet.open(registry, {
    root: opts.projectsRoot,
    single: opts.targetDir,
    mainBranch: opts.mainBranch,
    persist: opts.stateDir !== null,
    tasks: { policies: opts.policies, reclaimGraceMs: opts.reclaimGraceMs, qa: opts.qa },
    deps: { installer: opts.dependencyInstaller, allow: opts.allowDependencies },
    sync: { enabled: opts.sync?.enabled, remote: opts.sync?.remote, token: opts.sync?.token, retryMs: opts.sync?.retryMs },
    pullRequests: opts.pullRequests,
    onChange: (p) => notifier?.observe({ id: p.id, tasks: p.tasks.list(), plans: p.plans.list() }),
    onMerged: (p) => deployer?.request(p),
    followMs: opts.sync?.followMs,
  });
  const tasks = projects.tasks;
  const plans = projects.plans;
  // Agent conversations and push notification keys are Hub-wide (one gateway for all projects).
  const conversationDir =
    opts.stateDir === null
      ? undefined
      : opts.projectsRoot
        ? path.join(opts.projectsRoot, ".aso")
        : path.join(await projects.get("project")!.repo.gitDir(), "aso");
  const store = conversationDir ? new StateStore(conversationDir) : undefined;
  notifier = await Notifier.open({ dir: conversationDir, subject: opts.push?.contact ?? (process.env.ASO_PUSH_CONTACT || undefined), send: opts.push?.send });
  // Remember every record's current state, so only what changes from now on notifies.
  for (const p of projects.list()) notifier.observe({ id: p.id, tasks: p.tasks.list(), plans: p.plans.list() });
  const workerWatch = await WorkerWatch.open({ dir: conversationDir, alertMs: opts.push?.workerOfflineMs });
  const workerKeys = await WorkerKeys.open(conversationDir);
  // Saved owners keep a restarted Hub's held jobs with their credential. On start, before any node
  // is back, only node ids a task still names are kept: the rest have nothing left to protect.
  const nodeOwners = await NodeOwners.open(conversationDir);
  nodeOwners.prune(nodeIdsInUse(projects.list().flatMap((p) => p.tasks.list())));
  if (conversationDir) {
    deployer = new Deployer({
      dir: conversationDir,
      onResult: (project, status) => void notifier?.send(deployNotification(project, status)),
      run: hostDeploys?.run,
    });
    await deployer.load();
    await deployer.restore();
    // Deploy what was merged while the Hub was down, or whose deploy a restart cut off; projects
    // already live at their main are skipped.
    for (const p of projects.list()) deployer.request(p);
  }
  // A copy that looks out of date is checked again after catching up with GitHub. `close` waits for it.
  const apiSyncing = opts.apiSync === false ? Promise.resolve() : syncApiCopies(projects.list(), openApiDocument(API_DOC_VERSION), (p) => projects.followForPlanning(p));
  const llm = opts.llm ?? {};
  const model = llm.model ?? "claude-opus-5-5";
  const maxTokens = llm.maxTokens ?? DEFAULT_MAX_TOKENS;
  // `openai:<model>` goes to the OpenAI-compatible API at ASO_LLM_BASE_URL; anything else is a Claude model.
  const adapterFor = (spec: string): LlmAdapter | undefined =>
    openAiCompatibleFor(spec, process.env, maxTokens) ??
    (process.env.ANTHROPIC_API_KEY ? new AnthropicApiAdapter({ model: spec, effort: llm.effort ?? "high", maxTokens }) : undefined);
  const adapter = llm.adapter ?? adapterFor(model);
  const agentAdapter = llm.agentAdapter ?? (llm.agentModel && llm.agentModel !== model ? adapterFor(llm.agentModel) : undefined);
  if (!adapter) log.warn("no LLM configured: set ANTHROPIC_API_KEY, or use an openai:<model> with ASO_LLM_BASE_URL, to let agents work");
  else {
    log.info(`LLM: ${adapter.name} ${adapter.model}${agentAdapter ? ` (Architect); ${agentAdapter.model} (agents)` : ""}`);
    for (const a of [adapter, agentAdapter]) {
      if (a && !hasPrice(a.model)) log.warn(`no price known for ${a.model}; cost estimates will read $0, so task budgets won't stop it (the turn limit still does)`);
    }
  }
  // Desks can each use their own model; the catalog says which models there are to choose from.
  const deskModels = await DeskModels.open(
    conversationDir,
    (spec, settings) => adapterForModel(spec, settings, { env: process.env, maxTokens, effort: llm.effort ?? "high" }),
    llm.concurrency ?? 4,
  );
  const modelCatalog = new ModelCatalog(process.env);
  const conversations = new ConversationManager(adapter, tasks, registry, plans, {
    agentAdapter,
    deskModels,
    taskBudgetUsd: llm.taskBudgetUsd,
    planBudgetUsd: llm.planBudgetUsd,
    maxTurns: llm.maxTurns,
    concurrency: llm.concurrency,
    store,
    transcripts: projects.transcripts,
    onPause: (reason) => void notifier?.send({ title: "ASO is waiting for model credit", body: reason, url: "/", tag: "llm-paused" }),
    onResume: () => void notifier?.send({ title: "ASO is working again", body: "Model calls work again; waiting tasks and plans carry on.", url: "/", tag: "llm-paused" }),
  });
  await conversations.restore();

  /** The aso build this Hub serves to other machines; nodes on another build are flagged. */
  const hubVersion = () => (opts.dist?.tarball() ? opts.dist.version() : undefined);

  /** Idempotent: safe to call from both the timeout sweep and the socket close event. */
  const dropNode = (nodeId: string, transport: NodeTransport) => {
    const gone = registry.unregister(nodeId, transport);
    if (!gone) return;
    workerWatch.dropped(nodeId, gone.registration);
    for (const p of projects.list()) {
      p.tasks.handleNodeGone(nodeId);
      p.plans.handleNodeGone(nodeId);
    }
  };

  /** A node on another build than the Hub serves: have a worker update itself, or say to run `aso update`. */
  const checkVersion = (nodeId: string, p: Registration) => {
    const current = hubVersion();
    if (current === undefined || !isOutdated(p.version, current)) {
      if (p.nodeKind === "worker") registry.workerCurrent(nodeId);
      return;
    }
    const why =
      p.nodeKind !== "worker" ? undefined : opts.autoUpdate === false ? "automatic updates are off" : registry.requestUpdate(nodeId, current);
    if (p.nodeKind === "worker" && why === undefined) log.info(`${nodeId} runs aso ${p.version}: updating it to ${current} once it is idle`);
    else log.warn(`${nodeId} runs aso ${p.version}, this Hub serves ${current}: run \`aso update\` on it${why ? `; ${why}` : ""}`);
  };

  const reject = (conn: Connection, reason: string, issues: string[] = [], refId?: string) => {
    log.warn(`rejected message from ${conn.nodeId ?? conn.connId}: ${reason}`, issues.length ? issues : undefined);
    conn.ws.send(JSON.stringify(createMessage("PROTOCOL_ERROR", HUB_NODE_ID, { reason, issues, refId })));
  };

  const handleMessage = (conn: Connection, msg: AgentMessage) => {
    if (!NODE_TO_HUB_TYPES.has(msg.type)) {
      return reject(conn, `nodes may not send ${msg.type}`, [], msg.id);
    }

    // A revoked key's connection is cut at once; a message that raced the cut goes nowhere.
    if (conn.workerKey && !workerKeys.isActive(conn.workerKey.id)) return void conn.ws.close(4401, "worker key revoked");

    if (msg.type === "NODE_REGISTRATION") {
      if (conn.nodeId) return reject(conn, "already registered", [], msg.id);
      if (msg.from === HUB_NODE_ID || registry.has(msg.from)) {
        reject(conn, `node id "${msg.from}" is already in use`, [], msg.id);
        return conn.ws.close(4009, "duplicate node id");
      }
      const keyProblem = workerKeyProblem(conn, msg.from, msg.payload.nodeKind);
      if (keyProblem) {
        reject(conn, keyProblem, [], msg.id);
        return conn.ws.close(4403, keyProblem.slice(0, 120));
      }
      nodeOwners.record(msg.from, conn.workerKey?.id ?? null);
      replaceEarlier(conn);
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
          ? `worker ${msg.from} registered from ${p.hardware.hostname} (aso ${p.version}, ` +
              `${(p.hardware.memory.totalBytes / 1024 ** 3).toFixed(1)} GiB, ${p.hardware.storage.writeMBps} MB/s, ` +
              `docker ${p.hardware.docker.available ? "yes" : "no"})`
          : `architect ${msg.from} registered`,
      );
      registry.send(msg.from, "REGISTRATION_ACK", { nodeId: msg.from });
      const back = workerWatch.registered(msg.from, p);
      if (back) void notifier.send(back);
      for (const project of projects.list()) project.tasks.nodeRegistered(msg.from, runningJobsOf(p));
      // After the jobs it still runs are handed back: an update waits for them.
      checkVersion(msg.from, p);
      return projects.dispatchAll();
    }

    if (!conn.nodeId) return reject(conn, "NODE_REGISTRATION required first", [], msg.id);
    if (msg.from !== conn.nodeId) {
      return reject(conn, `envelope from "${msg.from}" does not match registered node`, [], msg.id);
    }
    registry.touch(conn.nodeId);

    switch (msg.type) {
      case "UPDATE_FAILED":
        log.warn(`${conn.nodeId} could not update to ${msg.payload.version}: ${msg.payload.reason}`);
        registry.updateFailed(conn.nodeId, msg.payload.version, msg.payload.reason);
        return projects.dispatchAll();
      case "NODE_HEARTBEAT": {
        const docker = registry.setHeartbeat(conn.nodeId, msg.payload);
        if (docker !== undefined) log.info(`${conn.nodeId}: Docker ${docker ? "now available" : "no longer available"}`);
        return;
      }
      case "STATUS_UPDATE": {
        const { taskId } = msg.payload;
        if (taskId === undefined) return; // idle keepalive
        const owner = projects.taskOwner(taskId);
        const error = owner ? owner.tasks.handleStatus(conn.nodeId, msg.payload) : `unknown task ${taskId}`;
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "DEPENDENCY_REQUEST": {
        const owner = projects.taskOwner(msg.payload.taskId);
        if (!owner) {
          // Answer rather than error, so the worker's pending request ends now instead of timing out.
          registry.send(conn.nodeId, "DEPENDENCY_RESPONSE", {
            requestId: msg.payload.requestId,
            outcome: "rejected",
            reason: `task ${msg.payload.taskId} is not being implemented by ${conn.nodeId}`,
          });
          return;
        }
        const error = owner.deps.handle(conn.nodeId, msg.payload);
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "PROMPT_EXECUTION": {
        const error = conversations.handle(conn.nodeId, msg.payload);
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "FILE_OPERATION": {
        const owner = projects.taskOwner(msg.payload.taskId);
        const error = owner ? owner.tasks.recordFileOperation(conn.nodeId, msg.payload) : `unknown task ${msg.payload.taskId}`;
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "PLAN_RESULT": {
        const owner = projects.planOwner(msg.payload.planId);
        const error = owner ? owner.plans.handleResult(conn.nodeId, msg.payload) : `plan ${msg.payload.planId} is not being planned by ${conn.nodeId}`;
        if (error) reject(conn, error, [], msg.id);
        return;
      }
      case "FEEDBACK_LOOP": {
        const owner = projects.taskOwner(msg.payload.taskId);
        const error = owner ? owner.tasks.handleFeedback(conn.nodeId, msg.payload) : `no QA run of ${msg.payload.taskId} is assigned to ${conn.nodeId}`;
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
  /**
   * Why a connection made with a worker key may not register as `nodeId`: a key registers one
   * worker, never the Architect, and never a node id another credential registered.
   */
  const workerKeyProblem = (conn: Connection, nodeId: string, kind: string): string | undefined => {
    const owner = nodeOwners.ownerOf(nodeId);
    const mine = conn.workerKey?.id ?? null;
    if (owner !== undefined && owner !== mine) return `node id "${nodeId}" belongs to another credential`;
    if (!conn.workerKey) return undefined;
    if (kind !== "worker") return "a worker key can only register a worker";
    return undefined;
  };
  /**
   * One worker per key: a new registration replaces the key's earlier connection (a machine back
   * after a power cut, whose old socket the Hub still thinks is open), so a key never has two
   * workers at once (e.g. one to implement and one to pass its own QA).
   */
  const replaceEarlier = (conn: Connection) => {
    if (!conn.workerKey) return;
    for (const other of connections.values()) {
      if (other === conn || other.workerKey?.id !== conn.workerKey.id || !other.nodeId) continue;
      log.info(`worker key ${conn.workerKey.id}: ${conn.nodeId ?? "a new connection"} replaces ${other.nodeId}`);
      other.ws.close(4409, "replaced by a newer connection with the same worker key");
      other.transport?.terminate();
      if (other.transport) dropNode(other.nodeId, other.transport);
    }
  };
  /** Cut every connection made with a key now: no close handshake to wait for, and its node is gone. */
  const cutOff = (keyId: string) => {
    for (const conn of connections.values()) {
      if (conn.workerKey?.id !== keyId) continue;
      conn.ws.close(4401, "worker key revoked");
      conn.transport?.terminate();
      if (conn.nodeId && conn.transport) dropNode(conn.nodeId, conn.transport);
    }
  };
  /** The worker key a request presents, if it is a valid one. */
  const workerKeyOf = (c: Context) => {
    const given = credentialOf(c.req.header("authorization"));
    return given === undefined ? undefined : workerKeys.verify(given);
  };
  /** Worker work (the worker connection, the projects' Git) also takes a worker key. */
  const requireWorker: MiddlewareHandler = async (c, next) => (workerKeyOf(c) ? next() : requireAuth(c, next));
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
  // Joining is public: the one-time code in the body is the credential.
  app.use("/api/*", async (c, next) =>
    ["/api/health", "/api/version", "/api/openapi.json", "/api/worker-keys/join"].includes(c.req.path) ? next() : requireAuth(c, next),
  );
  app.get("/api/openapi.json", (c) => c.json(openApiDocument(hubVersion() ?? UNKNOWN_VERSION)));
  app.use(`${GIT_PATH}/*`, requireWorker);
  app.use(WS_PATH, requireWorker);

  // Workers clone, fetch and push each project at /git/<project>.git; pushes are limited to task/* refs.
  // A worker key pushes only to the tasks its own worker is implementing.
  const git = gitHttpHandler(
    (id) => projects.get(id)?.dir,
    (c, project, refs) => {
      const key = workerKeyOf(c);
      if (!key) return undefined;
      const nodes = nodeOwners.nodesOf(key.id);
      for (const ref of refs) {
        const task = projects.get(project)?.tasks.get(ref.slice("refs/heads/task/".length));
        // Its own job, or one just cancelled or failed under it (the agent saves unfinished work then).
        const ours = task && ["assigned", "in_progress", "cancelled", "failed"].includes(task.state) && task.nodeId !== undefined && nodes.has(task.nodeId);
        if (!ours) return `this worker key has no job on ${ref}`;
      }
      return undefined;
    },
  );
  app.on(["GET", "POST"], [`${GIT_PATH}/*`], (c) => git(c));

  /** A project path as people know it (the host path when the Hub runs in Docker). */
  const shown = (dir: string) =>
    opts.projectsRoot && opts.projectsRootDisplay && dir.startsWith(opts.projectsRoot)
      ? opts.projectsRootDisplay + dir.slice(opts.projectsRoot.length)
      : dir;

  app.get("/api/health", (c) => {
    if (token !== null && !isAuthorized(c.req.header("authorization"), token)) return c.json({ status: "ok", auth: true });
    const only = projects.list().length === 1 ? projects.list()[0] : undefined;
    return c.json({
      status: "ok",
      auth: token !== null,
      projectsRoot: projects.root ? shown(projects.root) : null,
      projects: projects.list().map((p) => p.id),
      // Single-project details, kept for tools that predate projects.
      targetDir: only?.dir ?? null,
      stateDir: only?.store?.dir ?? null,
      mainBranch: only?.repo.mainBranch ?? null,
      sync: only?.sync.status() ?? null,
      qa: projects.list()[0]?.tasks.qa ?? null,
      allowDependencies: opts.allowDependencies ?? null,
      connections: connections.size,
      uptimeSec: Math.round(process.uptime()),
    });
  });

  /** A node for the API: whether it is outdated, and the job and desk of each task it runs. */
  const withOutdated = (n: ReturnType<NodeRegistry["view"]>) => ({
    ...n,
    outdated: isOutdated(n.version, hubVersion()),
    workerKey: [...connections.values()].find((c) => c.nodeId === n.nodeId)?.workerKey ?? null,
    jobs: n.currentTaskIds.map((taskId) => {
      const task = tasks.get(taskId);
      const job = task?.state === "testing" && task.qaNodeId === n.nodeId ? ("test" as const) : ("implement" as const);
      const seat = [...(task?.crew ?? [])].reverse().find((m) => m.job === job && m.nodeId === n.nodeId);
      return { taskId, job, ...(seat ? { slot: seat.slot } : {}) };
    }),
  });
  app.get("/api/nodes", (c) => c.json(registry.list().map(withOutdated)));

  // A person drains a worker (no new jobs; the current one finishes), resumes it, or restarts it once idle.
  const nodeAction = (c: Context, action: (id: string) => NodeEntry, done: (entry: NodeEntry) => string) => {
    try {
      const entry = action(c.req.param("id")!);
      log.info(done(entry));
      return c.json(withOutdated(registry.view(entry)));
    } catch (err) {
      if (!(err instanceof NodeError)) throw err;
      return c.json({ error: err.message }, err.code === "not_found" ? 404 : 409);
    }
  };
  app.post("/api/nodes/:id/drain", (c) => nodeAction(c, (id) => registry.drain(id), (n) => `${n.nodeId} draining: no new jobs`));
  app.post("/api/nodes/:id/resume", (c) =>
    nodeAction(
      c,
      (id) => {
        const entry = registry.resume(id);
        projects.dispatchAll(); // waiting tasks may go to it now
        return entry;
      },
      (n) => `${n.nodeId} takes jobs again`,
    ),
  );
  app.post("/api/nodes/:id/restart", (c) =>
    nodeAction(c, (id) => registry.requestRestart(id), (n) => `${n.nodeId} restart ${n.restart === "sent" ? "sent" : "requested once its current job is done"}`),
  );

  /** A request body as the API describes it (`@aso/shared` api.ts), or why it isn't. `optional`: it may be left out. */
  const parsed = async <T>(c: Context, schema: z.ZodType<T>, opts: { optional?: boolean } = {}) => {
    const data: unknown = await c.req.json().catch(() => undefined);
    return parseBody(schema, data === undefined && opts.optional ? {} : data);
  };

  // One-time console sign-in links (the console redeems them for a session; both need the token).
  const signInCodes = new SignInCodes();
  app.post("/api/sign-in-codes", (c) => c.json(signInCodes.create(), 201));
  app.post("/api/sign-in-codes/redeem", async (c) => {
    const req = await parsed(c, RedeemSignInCodeBodySchema);
    return req.ok && signInCodes.redeem(req.data.code) ? c.json({ ok: true }) : c.json({ error: "this sign-in link is used up or expired" }, 410);
  });

  app.get("/api/llm", (c) => c.json(conversations.status()));
  // Which model each desk's agents use: the models to choose from, and the desks' choices.
  const defaultAgentModel = () => (agentAdapter ?? adapter)?.model ?? null;
  app.get("/api/models", async (c) => {
    const { models: available, localError } = await modelCatalog.list();
    return c.json({ architect: adapter?.model ?? null, defaultAgent: defaultAgentModel(), available, ...(localError ? { localError } : {}) });
  });
  app.get("/api/desks", (c) => c.json(deskModels.view(adapter?.model ?? null, defaultAgentModel())));
  app.post("/api/desks", async (c) => {
    const req = await parsed(c, DeskAssignmentBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    const { target, model, ...settings } = req.data;
    const desks = desksOf(target, registry.workerSnapshots().map((w) => ({ hostname: w.hardware.hostname, slots: w.slots })));
    if (!Array.isArray(desks)) return c.json({ error: desks.error }, 404);
    let spec: string | null = null;
    if (model !== "default") {
      const resolved = resolveModel(model, (await modelCatalog.list()).models);
      if ("error" in resolved) return c.json({ error: resolved.error }, 400);
      spec = resolved.spec;
    }
    try {
      await deskModels.assign(desks, spec, Object.keys(settings).length ? settings : undefined);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(deskModels.view(adapter?.model ?? null, defaultAgentModel()));
  });

  /** Maps the errors a request can hit to HTTP statuses. */
  const fail = (c: Context, err: unknown) => {
    if (err instanceof ProjectError || err instanceof PlanError) {
      return c.json({ error: err.message }, err.code === "not_found" ? 404 : err.code === "conflict" ? 409 : err.code === "upstream" ? 502 : 400);
    }
    if (err instanceof TaskError) {
      const status = err.code === "not_found" ? 404 : err.code === "duplicate" || err.code === "conflict" ? 409 : err.code === "upstream" ? 502 : 400;
      return c.json({ error: err.message }, status);
    }
    throw err;
  };
  // Push notifications: devices subscribe from the console; the Hub notifies them of plans to
  // approve, failed tasks and finished plans.
  app.get("/api/push", (c) => c.json({ publicKey: notifier!.publicKey, devices: notifier!.subscriptionCount }));
  app.post("/api/push/subscriptions", async (c) => {
    const req = await parsed(c, PushSubscriptionSchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    await notifier!.subscribe(req.data);
    return c.json({ subscribed: true, devices: notifier!.subscriptionCount }, 201);
  });
  app.post("/api/push/subscriptions/check", async (c) => {
    const req = await parsed(c, PushEndpointSchema);
    return req.ok ? c.json({ subscribed: notifier!.has(req.data.endpoint) }) : c.json({ error: req.error }, 400);
  });
  app.post("/api/push/subscriptions/delete", async (c) => {
    const req = await parsed(c, PushEndpointSchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    return c.json({ removed: await notifier!.unsubscribe(req.data.endpoint), devices: notifier!.subscriptionCount });
  });
  app.post("/api/push/test", async (c) => {
    const req = await parsed(c, PushTestSchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    const { endpoint } = req.data;
    if (endpoint !== undefined && !notifier!.has(endpoint)) return c.json({ error: "this device is not subscribed" }, 404);
    if (!notifier!.subscriptionCount) return c.json({ error: "no device has notifications turned on" }, 404);
    const result = await notifier!.send(TEST_NOTIFICATION, endpoint);
    return c.json(result, result.sent ? 200 : 502);
  });

  const projectView = (p: Project) => {
    const list = p.tasks.list();
    const count = (states: string[]) => list.filter((t) => states.includes(t.state)).length;
    return {
      id: p.id,
      dir: shown(p.dir),
      mainBranch: p.repo.mainBranch,
      sync: p.sync.status(),
      pullRequests: p.pullRequests,
      tasks: {
        total: list.length,
        running: count(["assigned", "in_progress", "verifying", "awaiting_qa", "testing", "merging"]),
        reviewing: count(["awaiting_review"]),
        queued: count(["pending"]),
        failed: count(["failed"]),
        merged: count(["merged"]),
      },
      plansAwaitingApproval: p.plans.list().filter((pl) => pl.state === "proposed").length,
      plansWithQuestions: p.plans.list().filter((pl) => pl.state === "awaiting_input").length,
      deploy: deployer?.view(p.id) ?? { configured: false },
    };
  };
  app.get("/api/projects", (c) => c.json(projects.list().map(projectView)));
  app.get("/api/projects/:id", (c) => {
    const p = projects.get(c.req.param("id"));
    return p ? c.json(projectView(p)) : c.json({ error: "not found" }, 404);
  });
  app.post("/api/projects/:id/deploy", async (c) => {
    const p = projects.get(c.req.param("id"));
    if (!p) return c.json({ error: "not found" }, 404);
    if (!deployer) return c.json({ error: "this Hub keeps no state, so it has no deploy.json" }, 409);
    await deployer.load(); // to answer 409 from the file as it is now, not as of the last deploy
    if (!deployer.configured(p.id)) return c.json({ error: `${p.id} has no deploy command in ${shown(deployer.file)}` }, 409);
    deployer.request(p, { force: true });
    return c.json({ deploying: true }, 202);
  });
  app.get("/api/deploys/next", (c) => {
    if (!hostDeploys) return c.json({ error: "this Hub runs deploys itself" }, 404);
    return c.json({ job: hostDeploys.next() ?? null });
  });
  app.post("/api/deploys/:id/result", async (c) => {
    const req = await parsed(c, DeployResultBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    if (!hostDeploys?.complete(c.req.param("id"), req.data)) return c.json({ error: "no such deploy job waiting for a result" }, 404);
    return c.json({ accepted: true });
  });
  // Worker keys: a machine joins with a one-time code and gets a key for worker work only.
  /** Wrong join codes per client address and minute: one flood source can't block others joining. */
  const failedJoins = new Map<string, { minute: number; count: number }>();
  const clientAddress = (c: Context) => (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress ?? "unknown";
  app.post("/api/worker-keys/join-codes", async (c) => {
    const req = await parsed(c, JoinCodeBodySchema, { optional: true });
    if (!req.ok) return c.json({ error: req.error }, 400);
    return c.json(workerKeys.createJoinCode(req.data?.name), 201);
  });
  app.post("/api/worker-keys/join", async (c) => {
    const minute = Math.floor(Date.now() / 60_000);
    const from = clientAddress(c);
    const failed = failedJoins.get(from);
    const req = await parsed(c, JoinBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    // Only wrong codes are slowed down: behind a proxy every client shares an address, and a
    // flood of guesses must not keep a machine with a real code out.
    const limited = failed?.minute === minute && failed.count >= MAX_FAILED_JOINS_PER_MIN;
    if (limited && !workerKeys.hasCode(req.data.code)) return c.json({ error: "too many failed attempts; try again in a minute" }, 429);
    const joined = await workerKeys.join(req.data.code, req.data.machine);
    if (!joined) {
      for (const [address, f] of failedJoins) if (f.minute !== minute) failedJoins.delete(address);
      failedJoins.set(from, { minute, count: failed?.minute === minute ? failed.count + 1 : 1 });
      return c.json({ error: "unknown, used or expired join code: create a new one on the Hub" }, 403);
    }
    return c.json(joined, 201);
  });
  // LAN discovery: the Hub machine's responder (outside a container, where broadcasts arrive)
  // asks for the proof that answers a worker's query. Only the Hub's token may ask.
  app.post("/api/discovery/proof", async (c) => {
    const req = await parsed(c, DiscoveryProofBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    const { key, ...claim } = req.data;
    const own = token === null ? undefined : discoverySecret(token);
    const secret = own && discoveryKeyId(own) === key ? own : workerKeys.secretForKeyId(key);
    if (!secret) return c.json({ error: "no credential with that id" }, 404);
    return c.json({ proof: discoveryProof(secret, claim) });
  });
  const keyView = (k: WorkerKeyView) => ({ ...k, connected: [...connections.values()].some((c) => c.workerKey?.id === k.id) });
  app.get("/api/worker-keys", (c) => c.json(workerKeys.list().map(keyView)));
  app.post("/api/worker-keys/:id/revoke", async (c) => {
    const id = c.req.param("id");
    // Revoked in memory first: cut it off even if saving fails (the 500 then says so).
    const revoked = await workerKeys.revoke(id).catch((err: Error) => {
      cutOff(id);
      throw err;
    });
    if (!revoked) return c.json({ error: "no such worker key" }, 404);
    // Its machine stops now: its connection is cut, and it can't reconnect or fetch.
    cutOff(revoked.id);
    return c.json(keyView(revoked));
  });

  /** The Hub's own update, as the updater on its machine last reported it (`off` until it does). */
  const running = opts.dist?.version() ?? UNKNOWN_VERSION;
  let hubUpdate: HubUpdate = { state: "off", current: running };
  app.get("/api/hub/update", (c) => c.json(hubUpdate));
  app.post("/api/hub/update", async (c) => {
    const req = await parsed(c, HubUpdateReportBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    const next: HubUpdate = { ...req.data, current: running, at: new Date().toISOString() };
    const notification = hubUpdateNotification(hubUpdate, next);
    hubUpdate = next;
    if (notification) void notifier.send(notification);
    return c.json(hubUpdate);
  });
  app.post("/api/projects", async (c) => {
    const req = await parsed(c, CreateProjectBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    try {
      return c.json(projectView(await projects.create(req.data.name, { github: req.data.github })), 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  /** `?project=` narrows a list to one project. */
  const inProject = <T extends { project: string }>(c: Context, list: T[]) => {
    const project = c.req.query("project");
    return project ? list.filter((x) => x.project === project) : list;
  };

  app.get("/api/sync", (c) => {
    try {
      return c.json(projects.resolve(c.req.query("project")).sync.status());
    } catch (err) {
      return fail(c, err);
    }
  });
  app.post("/api/sync", async (c) => {
    try {
      const req = await parsed(c, SyncBodySchema, { optional: true });
      if (!req.ok) return c.json({ error: req.error }, 400);
      const p = projects.resolve(c.req.query("project") ?? req.data.project);
      await p.sync.requestPush();
      await projects.checkReviews(p.id);
      return c.json(p.sync.status());
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get("/api/plans", (c) => c.json(inProject(c, plans.list())));

  app.get("/api/plans/:id", (c) => {
    const plan = plans.get(c.req.param("id"));
    return plan ? c.json(plan) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/plans", async (c) => {
    const req = await parsed(c, CreatePlanBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    try {
      const p = projects.resolve(req.data.project);
      await projects.followForPlanning(p); // never throws
      return c.json(p.plans.create(req.data.requirement), 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  const planAction = (c: Context, action: (p: Project, id: string) => PlanRecord) => {
    const id = c.req.param("id")!;
    const owner = projects.planOwner(id);
    if (!owner) return c.json({ error: `plan ${id} not found` }, 404);
    try {
      return c.json(action(owner, id));
    } catch (err) {
      return fail(c, err);
    }
  };
  app.post("/api/plans/:id/approve", async (c) => {
    const owner = projects.planOwner(c.req.param("id"));
    if (owner) await projects.followForPlanning(owner); // planAction answers 404 without one
    return planAction(c, (p, id) => p.plans.approve(id));
  });
  app.post("/api/plans/:id/reject", (c) => planAction(c, (p, id) => p.plans.reject(id)));
  app.post("/api/plans/:id/reply", async (c) => {
    // The plan's own checks come first (a plan that takes no reply is a 409 whatever the body).
    const req = await parsed(c, PlanReplyBodySchema);
    return planAction(c, (p, id) => p.plans.reply(id, req.ok ? req.data.message : undefined));
  });

  app.get("/api/tasks", (c) => c.json(inProject(c, tasks.list())));

  /** `?after=<seq>` returns only newer entries, so the console can poll cheaply. */
  const transcript = (c: Context, kind: "task" | "plan", exists: boolean) => {
    if (!exists) return c.json({ error: "not found" }, 404);
    const after = Number(c.req.query("after") ?? -1);
    return c.json(projects.transcripts.read({ kind, id: c.req.param("id")! }, Number.isInteger(after) ? after : -1));
  };
  app.get("/api/tasks/:id/transcript", (c) => transcript(c, "task", !!tasks.get(c.req.param("id"))));
  app.get("/api/plans/:id/transcript", (c) => transcript(c, "plan", !!plans.get(c.req.param("id"))));

  app.get("/api/tasks/:id/screenshots/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const owner = projects.taskOwner(id);
    const file = owner?.tasks.get(id)?.screenshots?.files.find((f) => f.name === name);
    const data = file && (await owner!.screenshots.read(id, name));
    if (!file || !data) return c.json({ error: `task ${id} has no screenshot ${name}` }, 404);
    return c.body(new Uint8Array(data), 200, {
      "content-type": file.mediaType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
      "cache-control": "no-cache",
    });
  });

  const taskAction = (c: Context, action: (p: Project, id: string) => TaskRecord) => {
    const id = c.req.param("id")!;
    const owner = projects.taskOwner(id);
    if (!owner) return c.json({ error: `task ${id} not found` }, 404);
    try {
      return c.json(action(owner, id));
    } catch (err) {
      return fail(c, err);
    }
  };
  app.post("/api/tasks/:id/cancel", (c) => taskAction(c, (p, id) => p.tasks.cancel(id)));
  app.post("/api/tasks/:id/retry", (c) => taskAction(c, (p, id) => p.tasks.retry(id)));

  /** Like taskAction, for actions that wait on GitHub or Git and answer with something else than the task. */
  const taskQuery = async <T>(c: Context, action: (p: Project, id: string) => Promise<T>) => {
    const id = c.req.param("id")!;
    const owner = projects.taskOwner(id);
    if (!owner) return c.json({ error: `task ${id} not found` }, 404);
    try {
      return c.json(await action(owner, id));
    } catch (err) {
      return fail(c, err);
    }
  };
  // Reviewing in ASO: what the task changes, its pull request's checks, and the decision.
  app.get("/api/tasks/:id/diff", (c) =>
    taskQuery(c, async (p, id) => {
      const task = p.tasks.get(id)!;
      if (!task.commit || task.state === "merged") throw new TaskError(`task ${id} has no unmerged commit to show`, "conflict");
      const diff = await p.repo.diff(task.commit);
      if (!diff) throw new TaskError(`the Hub does not have task ${id}'s commit ${task.commit.slice(0, 8)}`, "conflict");
      return diff;
    }),
  );
  app.get("/api/tasks/:id/checks", (c) => taskQuery(c, (p, id) => p.tasks.reviewChecks(id)));
  app.post("/api/tasks/:id/approve", async (c) => {
    const req = await parsed(c, ApproveTaskBodySchema, { optional: true });
    if (!req.ok) return c.json({ error: req.error }, 400);
    return taskQuery(c, (p, id) => p.tasks.approve(id, req.data));
  });
  app.post("/api/tasks/:id/request-changes", async (c) => {
    const req = await parsed(c, RequestChangesBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    return taskAction(c, (p, id) => p.tasks.requestChanges(id, req.data.message));
  });

  app.get("/api/tasks/:id", (c) => {
    const task = tasks.get(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/tasks", async (c) => {
    const req = await parsed(c, CreateTaskBodySchema);
    if (!req.ok) return c.json({ error: req.error }, 400);
    try {
      const { project, ...spec } = req.data;
      return c.json(projects.resolve(project).tasks.submit(spec), 201);
    } catch (err) {
      return fail(c, err);
    }
  });

  app.get(
    WS_PATH,
    upgradeWebSocket((c) => {
      const connId = randomUUID();
      const key = workerKeyOf(c);
      let conn: Connection;
      return {
        onOpen(_evt, ws) {
          // Revoked between the upgrade and now: never let it in.
          if (key && !workerKeys.isActive(key.id)) return void ws.close(4401, "worker key revoked");
          conn = { connId, ws, ...(key ? { workerKey: { id: key.id, name: key.name } } : {}) };
          connections.set(connId, conn);
          log.info(`connection opened ${connId} (total ${connections.size})`);
        },
        onMessage(evt) {
          if (!conn) return; // refused in onOpen
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
  log.info(`listening on ${host}:${boundPort} (ws ${WS_PATH}, git ${GIT_PATH}/<project>.git), ${opts.projectsRoot ? `projects in ${opts.projectsRoot}` : `project ${opts.targetDir}`}`);

  // Half-open TCP connections (sleeping laptops, pulled cables) never fire onClose on their own.
  const sweep = setInterval(() => {
    for (const node of registry.stale(nodeTimeoutMs)) {
      log.warn(`node ${node.nodeId} timed out`);
      dropNode(node.nodeId, node.transport);
      node.transport.close(4008, "heartbeat timeout");
      // Live-but-slow peers get the close frame; dead peers are cut off after a grace period.
      setTimeout(() => node.transport.terminate(), 2000).unref();
    }
    for (const p of projects.list()) p.tasks.sweepDetached();
    conversations.sweep();
    for (const n of workerWatch.check()) void notifier.send(n);
    // Often enough for whichever of these delays is shortest (tests shorten them).
  }, Math.min(15_000, nodeTimeoutMs, opts.reclaimGraceMs ?? Infinity, opts.push?.workerOfflineMs ?? Infinity));
  sweep.unref();

  return {
    port: boundPort,
    registry,
    projects,
    tasks,
    plans,
    get sync() {
      return projects.resolve(undefined).sync;
    },
    routes: () => app.routes.filter((r) => r.method === "GET" || r.method === "POST").map((r) => ({ method: r.method, path: r.path })),
    close: async () => {
      clearInterval(sweep);
      await apiSyncing;
      // Save before the nodes are disconnected: those disconnects are the Hub's doing, and
      // restore() decides what happens to their jobs. Hub-side steps still running (a merge)
      // are saved mid-way and simply run again on the next start.
      await projects.close();
      await store?.close();
      for (const c of connections.values()) c.ws.close(1001, "hub shutting down");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
