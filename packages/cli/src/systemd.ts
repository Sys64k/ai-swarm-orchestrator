import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { configDir, createLogger } from "@aso/shared";
import { HUB_HOME_ENV } from "./self-update.js";
import { HUB_SERVICE, userUnitDir } from "./service.js";

const log = createLogger("cli");

/** A unit's file in the user's systemd directory. */
export const unitFile = (unit: string) => path.join(userUnitDir(), unit);
/** Holds ASO_TOKEN for the service when the worker can't find it by itself (owner-only). */
export const workerEnvFile = () => path.join(configDir(), "worker.env");

/** Run a systemd tool for the user's session (`systemctl --user`, `journalctl --user`, `loginctl`). */
export function userTool(tool: "systemctl" | "journalctl" | "loginctl" | "systemd-run", args: string[], opts: { show?: boolean } = {}): { ok: boolean; output: string } {
  const argv = tool === "loginctl" ? args : ["--user", ...args];
  const spawnOpts: SpawnSyncOptions = opts.show ? { stdio: "inherit" } : { encoding: "utf8" };
  const r = spawnSync(tool, argv, spawnOpts);
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
}

/** `systemctl --user <args>`, throwing with its output when it fails. */
export function systemctlOrThrow(args: string[]): void {
  const r = userTool("systemctl", args);
  if (!r.ok) throw new Error(`systemctl --user ${args.join(" ")} failed: ${r.output}`);
}

export function requireSystemd(): void {
  if (process.platform !== "linux") throw new Error("aso services need Linux with systemd; on other systems run the aso command under your own supervisor");
  const probe = userTool("systemctl", ["--version"]);
  if (!probe.ok) throw new Error(`systemctl --user is not available (${probe.output || "not found"}); run the aso command by hand instead`);
}

/** Whether a user unit is installed and running (`aso update` restarts it then). */
export function serviceActive(unit: string): boolean {
  if (process.platform !== "linux" || !existsSync(unitFile(unit))) return false;
  return userTool("systemctl", ["is-active", "--quiet", unit]).ok;
}

/** Restart a unit after an update; only warns when that fails (the update itself worked). */
export function restartAfterUpdate(unit: string): void {
  const r = userTool("systemctl", ["restart", unit]);
  if (r.ok) log.info(`restarted ${unit} on the new version`);
  else log.warn(`could not restart ${unit}: ${r.output}; run \`systemctl --user restart ${unit}\``);
}


/**
 * After switching versions: restart the Hub service from a transient unit of its own. Stopping
 * the service kills every process in it, a `systemctl` started from here included, which then
 * reports a failure although the restart goes ahead. Whether it happened is for the caller to
 * see: this process is stopped.
 */
export function restartHubService(): void {
  const r = userTool("systemd-run", ["--collect", "--no-block", `--unit=aso-hub-restart-${Date.now()}`, "systemctl", "--user", "restart", HUB_SERVICE]);
  if (!r.ok) log.warn(`could not ask systemd to restart ${HUB_SERVICE}: ${r.output}`);
}

/**
 * Have the previous version's CLI (`entry`, known to work) run `aso hub-update-check` in
 * `deadlineSec`, as a transient systemd timer outside the Hub service, which the update restarts.
 */
export async function armUpdateWatchdog(entry: string, deadlineSec: number, id: string): Promise<void> {
  const unit = `aso-hub-update-check-${id.slice(0, 8)}`;
  const home = process.env[HUB_HOME_ENV];
  const r = userTool("systemd-run", [
    "--collect",
    `--unit=${unit}`,
    `--on-active=${deadlineSec}`,
    ...(home ? [`--setenv=${HUB_HOME_ENV}=${home}`] : []),
    process.execPath,
    entry,
    "hub-update-check",
    "--id",
    id,
  ]);
  if (!r.ok) throw new Error(`systemd-run failed: ${r.output}`);
}
