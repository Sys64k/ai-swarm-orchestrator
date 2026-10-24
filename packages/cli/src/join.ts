import { lookup } from "node:dns/promises";
import os from "node:os";
import { createLogger, DEFAULT_DISCOVERY_PORT, discoverHub, hubHttpBase, isPrivateAddress, resolveHubUrl, saveWorkerKey } from "@aso/shared";

const log = createLogger("cli");

/**
 * Trade a join code (from `aso worker-key new` on the Hub, or its console) for this machine's
 * worker key, and save it. A machine on the Hub's LAN can find `hub` with the code (`findHub`).
 */
export async function joinHub(hub: string, port: number, code: string): Promise<{ id: string; name: string; hub: string }> {
  const base = hubHttpBase(hub, port);
  let res: Response;
  try {
    res = await fetch(`${base}/api/worker-keys/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, machine: machineName() }),
    });
  } catch {
    throw new Error(`cannot reach the Hub at ${base} to join it`);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; key?: string; error?: string };
  if (!res.ok || !body.key || !body.id || !body.name) throw new Error(`could not join the Hub: ${body.error ?? `HTTP ${res.status}`}`);
  const { file, replaced } = saveWorkerKey(body.key);
  log.info(`joined the Hub as "${body.name}" (worker key ${body.id}, saved in ${file})`);
  if (replaced) log.warn("this machine's previous worker key still works until it is revoked on the Hub (aso worker-keys)");
  return { id: body.id, name: body.name, hub };
}

/**
 * The Hub's `host:port`, found on the LAN with `credential` (a worker key, the Hub's token, or a
 * join code): only the Hub that holds it can answer.
 */
export async function findHub(credential: string, discover: (credential: string) => Promise<string | undefined> = discoverHub): Promise<string> {
  const found = await discover(credential);
  if (!found) {
    throw new Error(
      `no Hub answered on this network (UDP ${DEFAULT_DISCOVERY_PORT}). Check that it runs on this LAN, that the code or key is valid, ` +
        "and that no VPN or firewall drops broadcasts; or pass --hub <address>",
    );
  }
  return found;
}

/**
 * Refuse plain `ws://` to a Hub on the internet: the token, the code and every job would cross
 * it unencrypted. Private networks (the LAN, Tailscale's WireGuard) are fine; elsewhere use
 * `wss://`, or say `--allow-insecure`.
 */
export async function checkTransport(hub: string, port: number, allowInsecure: boolean, resolve = lookupAll): Promise<void> {
  const url = resolveHubUrl(hub, port);
  if (url.protocol === "wss:" || allowInsecure) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    // Unknown is not private: say so rather than connect blind (a service tries again shortly).
    throw new Error(`cannot resolve the Hub's address ${host}: ${(err as Error).message}`);
  }
  const exposed = addresses.find((ip) => !isPrivateAddress(ip));
  if (exposed) {
    throw new Error(
      `the Hub at ${host} (${exposed}) is on the internet, and ws:// would send the key and every job there unencrypted. ` +
        "Use wss://, a private network such as Tailscale, or --allow-insecure if you accept that",
    );
  }
}

/** This machine's hostname as the Hub accepts it (letters, digits, `._-`). */
export function machineName(hostname = os.hostname()): string {
  const clean = hostname.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100);
  return clean || "machine";
}

async function lookupAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((a) => a.address);
}
