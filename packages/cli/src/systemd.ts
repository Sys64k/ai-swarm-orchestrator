import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { configDir, createLogger } from "@aso/shared";
import { userUnitDir, WORKER_SERVICE } from "./service.js";

const log = createLogger("cli");

/** The worker's unit file. */
export const workerUnitFile = () => path.join(userUnitDir(), WORKER_SERVICE);
/** Holds ASO_TOKEN for the service when the worker can't find it by itself (owner-only). */
export const workerEnvFile = () => path.join(configDir(), "worker.env");

/** Run a systemd tool for the user's session (`systemctl --user`, `journalctl --user`, `loginctl`). */
export function userTool(tool: "systemctl" | "journalctl" | "loginctl", args: string[], opts: { show?: boolean } = {}): { ok: boolean; output: string } {
  const argv = tool === "loginctl" ? args : ["--user", ...args];
  const spawnOpts: SpawnSyncOptions = opts.show ? { stdio: "inherit" } : { encoding: "utf8" };
  const r = spawnSync(tool, argv, spawnOpts);
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error?.message ?? "") };
}

export function requireSystemd(): void {
  if (process.platform !== "linux") throw new Error("aso service needs Linux with systemd; on other systems run `aso start-worker` under your own supervisor");
  const probe = userTool("systemctl", ["--version"]);
  if (!probe.ok) throw new Error(`systemctl --user is not available (${probe.output || "not found"}); run \`aso start-worker\` instead`);
}

/** Whether the worker service is installed and running (`aso update` restarts it then). */
export function workerServiceActive(): boolean {
  if (process.platform !== "linux" || !existsSync(workerUnitFile())) return false;
  return userTool("systemctl", ["is-active", "--quiet", WORKER_SERVICE]).ok;
}

export function restartWorkerService(): void {
  const r = userTool("systemctl", ["restart", WORKER_SERVICE]);
  if (r.ok) log.info(`restarted ${WORKER_SERVICE} on the new version`);
  else log.warn(`could not restart ${WORKER_SERVICE}: ${r.output}; run \`systemctl --user restart ${WORKER_SERVICE}\``);
}
