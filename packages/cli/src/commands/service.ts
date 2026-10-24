import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { configDir, createLogger, DEFAULT_HUB_PORT, resolveWorkerToken, tokenFile, workerKeyFile } from "@aso/shared";
import { checkTransport, joinHub } from "../join.js";
import { execCommand } from "../exec.js";
import { HubVersions } from "../hub-versions.js";
import { HUB_HOME_ENV, updatePaths } from "../self-update.js";
import { gitBuildId, layout } from "../layout.js";
import { explicitArgs, HUB_SERVICE, needsTokenEnvFile, serviceUnit, userUnitDir, WORKER_SERVICE, workerArgs, type WorkerServiceOptions } from "../service.js";
import { requireSystemd, serviceActive, systemctlOrThrow, unitFile, userTool, workerEnvFile } from "../systemd.js";

const log = createLogger("cli");

/** The two services: `aso service` runs a worker, `aso hub-service` the Hub. */
interface ServiceKind {
  unit: string;
  /** What runs, for messages. */
  what: string;
  /** The aso command that manages it. */
  command: string;
  /** What to add to `<command> install`, for the hint when it is not installed. */
  installHint: string;
  /** Files the service owns besides its unit, removed with it (a function: their paths depend on the environment). */
  extraFiles: () => string[];
}

const WORKER: ServiceKind = {
  unit: WORKER_SERVICE,
  what: "worker",
  command: "aso service",
  installHint: "--hub <hub>",
  extraFiles: () => [workerEnvFile()],
};
const HUB: ServiceKind = { unit: HUB_SERVICE, what: "Hub", command: "aso hub-service", installHint: "[start-hub options]", extraFiles: () => [] };

/** The `start-hub` options `hub-service install` reads itself; the rest pass through `explicitArgs`. */
export interface HubServiceOptions {
  root: string;
  port: number;
  updateFrom?: string;
}

export async function installServiceCommand(opts: WorkerServiceOptions & { token?: string; join?: string }): Promise<void> {
  requireSystemd();
  const port = opts.port ?? DEFAULT_HUB_PORT;
  await checkTransport(opts.hub, port, opts.allowInsecure ?? false);
  if (opts.join) await joinHub(opts.hub, port, opts.join);
  const token = opts.token ? { token: opts.token, source: "--token" } : resolveWorkerToken();
  if (!token) throw new Error("no worker key: pass --join <code> (from `aso worker-key new` on the Hub), or --token");
  install(WORKER, `ASO worker (Hub ${opts.hub})`, workerArgs(opts, DEFAULT_HUB_PORT), syncTokenEnvFile(token));
}

/**
 * Install the Hub as a service with the `start-hub` options given here. The projects folder is
 * always passed (as an absolute path); other options come from where `start-hub` finds them.
 */
export async function installHubServiceCommand(opts: HubServiceOptions, cmd: Command): Promise<void> {
  requireSystemd();
  if (!serviceActive(HUB_SERVICE) && (await hubAnswers(opts.port))) {
    throw new Error(`a Hub already answers on port ${opts.port}; stop it first (Ctrl+C where it runs), then install the service`);
  }
  warnIfOnlyInShell("ANTHROPIC_API_KEY");
  const args = ["start-hub", ...explicitArgs(cmd, { always: ["root"], map: { root: (dir) => path.resolve(dir) } })];
  if (!opts.updateFrom) return install(HUB, "ASO Hub", args);
  const versions = await installFirstVersion();
  install(HUB, "ASO Hub", args, undefined, {
    script: versions.currentEntry,
    // Each start first lets the version before an update roll back one past its deadline (after a reboot, say).
    execStartPre: [process.execPath, versions.previousEntry, "hub-update-check", "--at-start"],
    env: { [HUB_HOME_ENV]: versions.root },
  });
}

/**
 * For `--update-from`: install the package this aso has (a checkout's `npm run package`, or the
 * installed package itself) as the Hub's first version, and return the CLI the service runs: the
 * one `current` points at, which updates switch.
 */
async function installFirstVersion(): Promise<HubVersions> {
  const tarball = layout.distTarball();
  const version = layout.distVersion();
  if (!tarball || !version) throw new Error("no aso package to install for --update-from: run `npm run package` in the checkout first");
  // From a checkout, the package must be this commit's: an older one may not know --update-from.
  if (layout.sourceRoot && version.split("+")[1] !== gitBuildId(layout.sourceRoot)) {
    throw new Error(`release/aso.tgz is ${version}, not this checkout (${gitBuildId(layout.sourceRoot)}): run \`npm run package\` with no uncommitted changes first`);
  }
  if (version.endsWith("-dirty")) throw new Error(`${version} was built with uncommitted changes; commit them and run \`npm run package\` again`);
  const versions = new HubVersions(updatePaths().versions);
  const dir = await versions.install(version, tarball, execCommand);
  // The service will run this CLI: make sure it starts and knows what updates need.
  const help = await execCommand(process.execPath, [versions.entry(dir), "start-hub", "--help"]);
  if (!help.includes("--update-from")) throw new Error(`${version} has no --update-from: build a newer package`);
  await execCommand(process.execPath, [versions.entry(dir), "hub-update-check", "--help"]);
  await versions.switchTo(dir);
  log.info(`installed ${version} in ${dir}; the service runs ${versions.currentEntry}`);
  // A package reads ~/.config/aso/.env, not a checkout's .env.
  const own = path.join(configDir(), ".env");
  const settings = existsSync(own) ? readFileSync(own, "utf8") : "";
  for (const name of ["ANTHROPIC_API_KEY", "ASO_GIT_TOKEN"]) {
    if (process.env[name] && !new RegExp(`^\\s*(export\\s+)?${name}\\s*=`, "m").test(settings)) {
      log.warn(`${name} is not in ${own}: the service runs the installed package, which reads settings from there (mode 600)`);
    }
  }
  return versions;
}

/** A service reads the `.env` files aso loads, not the shell that installed it. */
function warnIfOnlyInShell(name: string): void {
  if (!process.env[name] || envFilesSet(name)) return;
  log.warn(
    `${name} is set in your shell but in no .env file aso reads, so the service will not see it: ` +
      `add it to ${layout.envFiles()[0] ?? "~/.config/aso/.env"} (mode 600)`,
  );
}

function install(
  kind: ServiceKind,
  description: string,
  args: string[],
  envFile?: string,
  extra: { script?: string; execStartPre?: string[]; env?: Record<string, string> } = {},
): void {
  const file = unitFile(kind.unit);
  const unit = serviceUnit({
    description,
    installedBy: kind.command,
    node: process.execPath,
    script: extra.script ?? path.resolve(process.argv[1]),
    execStartPre: extra.execStartPre,
    env: extra.env,
    args,
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    envFile,
  });
  mkdirSync(userUnitDir(), { recursive: true });
  writeFileSync(file, unit);
  log.info(`wrote ${file}`);

  for (const step of [["daemon-reload"], ["enable", kind.unit], ["restart", kind.unit]]) systemctlOrThrow(step);
  log.info(`${kind.unit} is running and starts with your user session`);
  ensureLinger(kind);
  console.log(`\nStatus: ${kind.command} status    Logs: ${kind.command} logs -f    Remove: ${kind.command} uninstall`);
}

async function hubAnswers(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** The contents of the `.env` files the CLI loads on start (a service finds what they set). */
function envFileContents(): string[] {
  return layout.envFiles().filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8"));
}

function envFilesSet(name: string): boolean {
  return envFileContents().some((text) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*\\S`, "m").test(text));
}

/** Write the service's private token file when it needs one (else remove a stale one). Returns its path if used. */
function syncTokenEnvFile(token: { token: string; source: string }): string | undefined {
  const file = workerEnvFile();
  if (!needsTokenEnvFile(token, [tokenFile(), workerKeyFile()], envFileContents())) {
    if (existsSync(file)) rmSync(file);
    return undefined;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `ASO_TOKEN=${token.token}\n`, { mode: 0o600 });
  return file;
}

/** Without lingering, user services stop at logout and only start once you log in. */
function ensureLinger(kind: ServiceKind): void {
  const user = os.userInfo().username;
  if (userTool("loginctl", ["show-user", user, "--property=Linger"]).output === "Linger=yes") return;
  if (userTool("loginctl", ["enable-linger", user]).ok) {
    log.info(`enabled lingering: the ${kind.what} starts at boot and keeps running after you log out`);
    return;
  }
  log.warn(
    `the ${kind.what} only runs while you are logged in. To start it at boot and keep it running after logout, run once:\n` +
      `    sudo loginctl enable-linger ${user}`,
  );
}

function uninstall(kind: ServiceKind): void {
  requireSystemd();
  if (!installed(kind)) {
    log.info(`${kind.unit} is not installed`);
    return;
  }
  const file = unitFile(kind.unit);
  // Best effort: a unit that is already stopped or disabled is fine; the files go either way.
  userTool("systemctl", ["disable", "--now", kind.unit]);
  rmSync(file);
  for (const extra of kind.extraFiles()) if (existsSync(extra)) rmSync(extra);
  userTool("systemctl", ["daemon-reload"]);
  log.info(`removed ${kind.unit}`);
}

function installed(kind: ServiceKind): boolean {
  return existsSync(unitFile(kind.unit));
}

const notInstalled = (kind: ServiceKind) => `${kind.unit} is not installed (${kind.command} install ${kind.installHint})`;

function status(kind: ServiceKind): void {
  requireSystemd();
  if (!installed(kind)) return console.log(notInstalled(kind));
  userTool("systemctl", ["status", "--no-pager", "--lines=15", kind.unit], { show: true });
}

function restart(kind: ServiceKind): void {
  requireSystemd();
  if (!installed(kind)) throw new Error(notInstalled(kind));
  systemctlOrThrow(["restart", kind.unit]);
  log.info(`restarted ${kind.unit}`);
}

function logs(kind: ServiceKind, opts: { follow: boolean; lines: string }): void {
  requireSystemd();
  userTool("journalctl", ["--unit", kind.unit, "--no-pager", "--lines", opts.lines, ...(opts.follow ? ["--follow"] : [])], { show: true });
}

export const uninstallServiceCommand = () => uninstall(WORKER);
export const statusServiceCommand = () => status(WORKER);
export const logsServiceCommand = (opts: { follow: boolean; lines: string }) => logs(WORKER, opts);

export const uninstallHubServiceCommand = () => uninstall(HUB);
export const statusHubServiceCommand = () => status(HUB);
export const restartHubServiceCommand = () => restart(HUB);
export const logsHubServiceCommand = (opts: { follow: boolean; lines: string }) => logs(HUB, opts);
