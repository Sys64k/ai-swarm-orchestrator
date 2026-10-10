import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHITECT_TMUX_SESSION, createLogger } from "@aso/shared";
import { startHub, type Effort } from "@aso/hub";

const log = createLogger("cli");

export interface StartHubOptions {
  dir: string;
  port: number;
  host: string;
  dashboardPort: number;
  dashboard: boolean;
  architect: boolean;
  docker: boolean;
  testCommand: string;
  qa: boolean;
  allowDeps?: string;
  model: string;
  effort: Effort;
  taskBudget: number;
  llmConcurrency: number;
}

export async function startHubCommand(opts: StartHubOptions): Promise<void> {
  const targetDir = resolveTargetDir(opts.dir);
  if (opts.docker) return startHubInDocker(targetDir, opts);

  const testCommand = parseTestCommand(opts.testCommand);
  const qaEnabled = opts.qa && process.env.ASO_QA !== "0";
  const hub = await startHub({
    targetDir,
    port: opts.port,
    host: opts.host,
    qa: { enabled: qaEnabled, command: testCommand },
    allowDependencies: parseList(opts.allowDeps),
    llm: {
      model: opts.model,
      effort: opts.effort,
      taskBudgetUsd: opts.taskBudget,
      concurrency: opts.llmConcurrency,
    },
  });
  const dashboard = opts.dashboard ? launchDashboard(opts.dashboardPort, hub.port) : undefined;
  const architectStarted = opts.architect ? launchArchitect(hub.port) : false;

  onShutdown(async () => {
    dashboard?.kill("SIGTERM");
    if (architectStarted) tmux(["kill-session", "-t", ARCHITECT_TMUX_SESSION]);
    await hub.close();
    process.exit(0);
  });
}

/**
 * Runs the Hub + dashboard via docker compose and the Architect in tmux on the host (it
 * reaches the Hub through the published port). Compose runs attached so logs stream here.
 */
async function startHubInDocker(targetDir: string, opts: StartHubOptions): Promise<void> {
  if (!opts.dashboard) throw new Error("--no-dashboard is not supported with --docker");
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
  } catch {
    throw new Error("docker compose is not available; install Docker Compose v2 or drop --docker");
  }

  const composeFile = fileURLToPath(new URL("../../../../docker-compose.yml", import.meta.url));
  if (!existsSync(composeFile)) throw new Error(`compose file not found at ${composeFile}`);

  const compose = spawn("docker", ["compose", "-f", composeFile, "up", "--build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ASO_TARGET_DIR: targetDir,
      ASO_UID: String(process.getuid?.() ?? 1000),
      ASO_GID: String(process.getgid?.() ?? 1000),
      ASO_BIND: opts.host,
      ASO_HUB_PORT: String(opts.port),
      ASO_DASHBOARD_PORT: String(opts.dashboardPort),
      ASO_TEST_COMMAND: parseTestCommand(opts.testCommand).join(" "),
      ASO_QA: opts.qa ? "1" : "0",
      ASO_ALLOW_DEPS: parseList(opts.allowDeps)?.join(",") ?? "",
      ASO_MODEL: opts.model,
      ASO_EFFORT: opts.effort,
      ASO_TASK_BUDGET: String(opts.taskBudget),
      ASO_LLM_CONCURRENCY: String(opts.llmConcurrency),
    },
  });
  const exited = new Promise<number>((resolve) => compose.on("exit", (code) => resolve(code ?? 1)));
  log.info(`starting Hub container (first run builds the image; this can take a few minutes)`);

  let architectStarted = false;
  if (opts.architect) {
    const healthy = await waitForHealth(`http://127.0.0.1:${opts.port}/api/health`, exited);
    if (healthy) architectStarted = launchArchitect(opts.port);
  }

  onShutdown(async (signal) => {
    if (architectStarted) tmux(["kill-session", "-t", ARCHITECT_TMUX_SESSION]);
    // Ctrl+C already reached compose via the terminal's process group; a second SIGINT would
    // make compose force-kill the container. Only forward signals that came from elsewhere.
    if (signal !== "SIGINT") compose.kill(signal);
    process.exit(await exited);
  });
  const code = await exited;
  if (architectStarted) tmux(["kill-session", "-t", ARCHITECT_TMUX_SESSION]);
  process.exit(code);
}

async function waitForHealth(url: string, exited: Promise<number>): Promise<boolean> {
  let done = false;
  void exited.then(() => (done = true));
  while (!done) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function onShutdown(handler: (signal: NodeJS.Signals) => Promise<void>): void {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info(`${signal} received, shutting down`);
      void handler(signal);
    });
  }
}

function parseTestCommand(cmd: string): string[] {
  const argv = cmd.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new Error("--test-command must not be empty");
  return argv;
}

function parseList(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

function resolveTargetDir(dir: string): string {
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`target directory does not exist: ${abs}`);
  }
  return abs;
}

function tmux(args: string[]): boolean {
  try {
    execFileSync("tmux", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Starts the Architect in a detached tmux session. Returns true if this process created it. */
function launchArchitect(hubPort: number): boolean {
  if (!tmux(["-V"])) {
    log.warn("tmux not found; skipping Architect session (install tmux or use --no-architect)");
    return false;
  }
  if (tmux(["has-session", "-t", ARCHITECT_TMUX_SESSION])) {
    log.warn(`tmux session "${ARCHITECT_TMUX_SESSION}" already exists; leaving it running`);
    return false;
  }
  const entry = fileURLToPath(import.meta.resolve("@aso/architect/main"));
  const ok = tmux([
    "new-session", "-d", "-s", ARCHITECT_TMUX_SESSION, "--",
    process.execPath, entry, "--hub", `127.0.0.1:${hubPort}`,
  ]);
  if (ok) log.info(`Architect started (tmux attach -t ${ARCHITECT_TMUX_SESSION})`);
  else log.error("failed to start Architect tmux session");
  return ok;
}

function launchDashboard(port: number, hubPort: number): ChildProcess | undefined {
  const require = createRequire(import.meta.url);
  let dashboardDir: string;
  let nextBin: string;
  try {
    dashboardDir = path.dirname(require.resolve("@aso/dashboard/package.json"));
    nextBin = require.resolve("next/dist/bin/next", { paths: [dashboardDir] });
  } catch {
    log.warn("dashboard package not found; skipping (use --no-dashboard to silence)");
    return undefined;
  }

  const built = existsSync(path.join(dashboardDir, ".next", "BUILD_ID"));
  const mode = built ? "start" : "dev";
  const child = spawn(process.execPath, [nextBin, mode, "-p", String(port)], {
    cwd: dashboardDir,
    env: { ...process.env, ASO_HUB_PORT: String(hubPort) },
    stdio: "inherit",
  });
  child.on("exit", (code) => code && log.warn(`dashboard exited with code ${code}`));
  log.info(`dashboard (${mode}) on http://localhost:${port}`);
  return child;
}
