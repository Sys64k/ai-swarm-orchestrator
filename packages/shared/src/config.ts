import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** This machine's worker key, from joining a Hub (`--join`). Owner-only. */
export function workerKeyFile(): string {
  return path.join(configDir(), "worker-key");
}

/**
 * Save the worker key a Hub gave this machine: a new owner-only file renamed over the old one, so
 * the key is never readable by others, not even for a moment. `replaced`: there was one before.
 */
export function saveWorkerKey(key: string): { file: string; replaced: boolean } {
  const file = workerKeyFile();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const replaced = existsSync(file);
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${key}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
  return { file, replaced };
}

/**
 * What a worker presents to the Hub: its own worker key when it has joined one (so an old
 * ASO_TOKEN left in a .env doesn't quietly keep the Hub's all-powerful token in use), else
 * ASO_TOKEN, else the Hub's token file (on the Hub machine).
 */
export function resolveWorkerToken(): { token: string; source: string } | undefined {
  const key = workerKeyFile();
  if (existsSync(key)) {
    const token = readFileSync(key, "utf8").trim();
    if (token) return { token, source: key };
  }
  if (process.env.ASO_TOKEN) return { token: process.env.ASO_TOKEN, source: "ASO_TOKEN" };
  return resolveToken();
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
