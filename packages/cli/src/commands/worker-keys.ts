import os from "node:os";
import { hubHttpBase } from "@aso/shared";
import { api } from "../hub-api.js";

interface WorkerKey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  connected: boolean;
}

/**
 * What to run on a new machine to install aso and join the Hub at `address` with `code`. The
 * package is checked against `sha256` (the Hub's, read here over a trusted connection) before
 * it is installed, so one swapped on the way doesn't run.
 */
export function joinInstructions(address: string, code: string, expiresAt: string, sha256?: string): string[] {
  return [
    `On the new machine (the code works once, until ${expiresAt}):`,
    "",
    `  ${joinCommand(address, code, sha256)}`,
    "",
    "It finds the Hub by itself, on this LAN or over Tailscale (both machines in your tailnet), and",
    "again whenever it moves between them or the Hub's address changes. If it can't, add",
    `--hub ${address} to the last part, or give the Hub a wss:// address.`,
    "",
    "It gets its own worker key: it can take jobs and use the projects' Git, nothing else, and",
    "`aso worker-key revoke <id>` (or the console) shuts it out.",
  ];
}

/**
 * The one line a new machine runs: install aso from the Hub at `address`, then join with `code`.
 * The console builds the same line (`joinCommand` in packages/dashboard/lib/view.ts): keep them in step.
 */
export function joinCommand(address: string, code: string, sha256?: string | null): string {
  return `${installCommand(hubHttpBase(address), sha256)} && aso service install --join ${code}`;
}

/**
 * Download the package into a fresh private folder (no other user can swap a file there between
 * the check and the install), check it against `sha256` when known, and install it.
 */
export function installCommand(http: string, sha256?: string | null): string {
  const check = sha256 ? ` && echo "${sha256}  $d/aso.tgz" | sha256sum -c -` : "";
  return `d=$(mktemp -d) && curl -fo "$d/aso.tgz" ${http}/dist/aso.tgz${check} && npm install -g "$d/aso.tgz"`;
}

/** One line per key, for `aso worker-keys`. */
export function keyLine(k: WorkerKey): string {
  const state = k.revokedAt ? `revoked ${k.revokedAt}` : k.connected ? "connected" : k.lastUsedAt ? `last used ${k.lastUsedAt}` : "never used";
  return `${k.id}  ${k.name}  (${state})`;
}

/** `aso worker-key new`: a one-time join code, and the commands to run with it on the new machine. */
export async function newWorkerKeyCommand(opts: { hub: string; address?: string; name?: string }): Promise<void> {
  const version = await api<{ sha256: string | null }>(hubHttpBase(opts.hub), "/api/version");
  const joined = await api<{ code: string; expiresAt: string }>(hubHttpBase(opts.hub), "/api/worker-keys/join-codes", {
    method: "POST",
    body: JSON.stringify(opts.name ? { name: opts.name } : {}),
  });
  // Machines elsewhere reach the Hub by its name (on Tailscale, its MagicDNS name), not 127.0.0.1.
  const address = opts.address ?? (opts.hub === "127.0.0.1" || opts.hub === "localhost" ? os.hostname() : opts.hub);
  console.log(joinInstructions(address, joined.code, joined.expiresAt, version.sha256 ?? undefined).join("\n"));
}

/** `aso worker-keys`: every worker key, revoked ones included. */
export async function listWorkerKeysCommand(opts: { hub: string }): Promise<void> {
  const keys = await api<WorkerKey[]>(hubHttpBase(opts.hub), "/api/worker-keys");
  if (keys.length === 0) return void console.log("No worker keys yet: `aso worker-key new` lets a machine join with its own.");
  for (const k of keys) console.log(keyLine(k));
}

/** `aso worker-key revoke <id>`: the machine is disconnected and can't come back with its key. */
export async function revokeWorkerKeyCommand(id: string, opts: { hub: string }): Promise<void> {
  const k = await api<WorkerKey>(hubHttpBase(opts.hub), `/api/worker-keys/${encodeURIComponent(id)}/revoke`, { method: "POST" });
  console.log(`revoked ${k.id} (${k.name})`);
}
