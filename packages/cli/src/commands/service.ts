import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, DEFAULT_HUB_PORT, resolveToken, tokenFile } from "@aso/shared";
import { layout } from "../layout.js";
import { needsTokenEnvFile, userUnitDir, WORKER_SERVICE, workerArgs, workerUnit, type WorkerServiceOptions } from "../service.js";
import { requireSystemd, userTool, workerEnvFile, workerUnitFile } from "../systemd.js";

const log = createLogger("cli");

export function installServiceCommand(opts: WorkerServiceOptions & { token?: string }): void {
  requireSystemd();
  const token = opts.token ? { token: opts.token, source: "--token" } : resolveToken();
  if (!token) throw new Error("no ASO token: pass --token or set ASO_TOKEN (run `aso token` on the Hub machine to see it)");

  const unit = workerUnit({
    node: process.execPath,
    script: path.resolve(process.argv[1]),
    args: workerArgs(opts, DEFAULT_HUB_PORT),
    path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    envFile: syncTokenEnvFile(token),
    hub: opts.hub,
  });
  mkdirSync(userUnitDir(), { recursive: true });
  writeFileSync(workerUnitFile(), unit);
  log.info(`wrote ${workerUnitFile()}`);

  for (const args of [["daemon-reload"], ["enable", WORKER_SERVICE], ["restart", WORKER_SERVICE]]) {
    const r = userTool("systemctl", args);
    if (!r.ok) throw new Error(`systemctl --user ${args.join(" ")} failed: ${r.output}`);
  }
  log.info(`${WORKER_SERVICE} is running and starts with your user session`);
  ensureLinger();
  console.log(`\nStatus: aso service status    Logs: aso service logs -f    Remove: aso service uninstall`);
}

/** Write the service's private token file when it needs one (else remove a stale one). Returns its path if used. */
function syncTokenEnvFile(token: { token: string; source: string }): string | undefined {
  const envContents = layout.envFiles().filter((f) => existsSync(f)).map((f) => readFileSync(f, "utf8"));
  const file = workerEnvFile();
  if (!needsTokenEnvFile(token, tokenFile(), envContents)) {
    if (existsSync(file)) rmSync(file);
    return undefined;
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `ASO_TOKEN=${token.token}\n`, { mode: 0o600 });
  return file;
}

/** Without lingering, user services stop at logout and only start once you log in. */
function ensureLinger(): void {
  const user = os.userInfo().username;
  if (userTool("loginctl", ["show-user", user, "--property=Linger"]).output === "Linger=yes") return;
  if (userTool("loginctl", ["enable-linger", user]).ok) {
    log.info("enabled lingering: the worker starts at boot and keeps running after you log out");
    return;
  }
  log.warn(
    `the worker only runs while you are logged in. To start it at boot and keep it running after logout, run once:\n` +
      `    sudo loginctl enable-linger ${user}`,
  );
}

export function uninstallServiceCommand(): void {
  requireSystemd();
  if (!existsSync(workerUnitFile())) {
    log.info(`${WORKER_SERVICE} is not installed`);
    return;
  }
  // Best effort: a unit that is already stopped or disabled is fine; the files go either way.
  userTool("systemctl", ["disable", "--now", WORKER_SERVICE]);
  rmSync(workerUnitFile());
  if (existsSync(workerEnvFile())) rmSync(workerEnvFile());
  userTool("systemctl", ["daemon-reload"]);
  log.info(`removed ${WORKER_SERVICE}`);
}

export function statusServiceCommand(): void {
  requireSystemd();
  if (!existsSync(workerUnitFile())) {
    console.log(`${WORKER_SERVICE} is not installed (aso service install --hub <hub>)`);
    return;
  }
  userTool("systemctl", ["status", "--no-pager", "--lines=15", WORKER_SERVICE], { show: true });
}

export function logsServiceCommand(opts: { follow: boolean; lines: string }): void {
  requireSystemd();
  userTool("journalctl", ["--unit", WORKER_SERVICE, "--no-pager", "--lines", opts.lines, ...(opts.follow ? ["--follow"] : [])], { show: true });
}
