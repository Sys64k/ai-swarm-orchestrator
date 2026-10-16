import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { configDir, createLogger } from "@aso/shared";
import { userUnitDir } from "./service.js";

const log = createLogger("cli");

/** A unit's file in the user's systemd directory. */
export const unitFile = (unit: string) => path.join(userUnitDir(), unit);
/** Holds ASO_TOKEN for the service when the worker can't find it by itself (owner-only). */
export const workerEnvFile = () => path.join(configDir(), "worker.env");

/** Run a systemd tool for the user's session (`systemctl --user`, `journalctl --user`, `loginctl`). */
export function userTool(tool: "systemctl" | "journalctl" | "loginctl", args: string[], opts: { show?: boolean } = {}): { ok: boolean; output: string } {
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

