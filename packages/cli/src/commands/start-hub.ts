import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHITECT_TMUX_SESSION, createLogger } from "@aso/shared";
import { startHub } from "@aso/hub";

const log = createLogger("cli");

export interface StartHubOptions {
  dir: string;
  port: number;
  host: string;
  dashboardPort: number;
  dashboard: boolean;
  architect: boolean;
}

export async function startHubCommand(opts: StartHubOptions): Promise<void> {
  const targetDir = resolveTargetDir(opts.dir);
  const hub = await startHub({ targetDir, port: opts.port, host: opts.host });

  const dashboard = opts.dashboard ? launchDashboard(opts.dashboardPort, hub.port) : undefined;
  const architectStarted = opts.architect ? launchArchitect(hub.port) : false;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    dashboard?.kill("SIGTERM");
    if (architectStarted) tmux(["kill-session", "-t", ARCHITECT_TMUX_SESSION]);
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function resolveTargetDir(dir: string): string {
  const abs = path.resolve(dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new Error(`target directory does not exist: ${abs}`);
  }
  try {
    execFileSync("git", ["-C", abs, "rev-parse", "--is-inside-work-tree"], { stdio: "ignore" });
  } catch {
    log.warn(`${abs} is not a git repository; the Git flow will need it initialised`);
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
  const entry = fileURLToPath(import.meta.resolve("@aso/hub/architect"));
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
