import { spawnSync } from "node:child_process";
import { createLogger } from "@aso/shared";

const log = createLogger("cli");

export function updateCommand(spec: string, currentVersion: string): void {
  log.info(`current version ${currentVersion}; installing ${spec}`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "--global", spec], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm install exited with code ${result.status}`);
  }
  log.info("update complete; run `aso --version` to confirm");
}
