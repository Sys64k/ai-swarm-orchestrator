import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateToken } from "./auth.js";

/** Per-user ASO configuration directory (override with ASO_CONFIG_DIR, e.g. in tests). */
export function configDir(): string {
  return process.env.ASO_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aso");
}

export function tokenFile(): string {
  return path.join(configDir(), "token");
}

/**
 * The ASO token: ASO_TOKEN from the environment, else the token file. With `create`, a new
 * token is generated and saved (mode 600) when neither exists; the Hub does this on first start.
 */
export function resolveToken(opts: { create?: boolean } = {}): { token: string; source: string; created: boolean } | undefined {
  if (process.env.ASO_TOKEN) return { token: process.env.ASO_TOKEN, source: "ASO_TOKEN", created: false };
  const file = tokenFile();
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token) return { token, source: file, created: false };
  }
  if (!opts.create) return undefined;
  const token = generateToken();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: "wx" });
  return { token, source: file, created: true };
}
