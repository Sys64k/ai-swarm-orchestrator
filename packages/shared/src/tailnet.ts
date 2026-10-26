import { execFile } from "node:child_process";

/**
 * This machine's Tailscale network as `tailscale status --json` describes it: whether Tailscale
 * runs here, and the other machines that are online now. Discovery asks those peers directly,
 * since LAN broadcasts don't cross Tailscale.
 */
export interface Tailnet {
  /** Tailscale is installed and connected on this machine. */
  running: boolean;
  /** Online peers' Tailscale IPv4 addresses (the 100.64.0.0/10 ones). */
  peers: readonly string[];
}

export const NO_TAILNET: Readonly<Tailnet> = Object.freeze({ running: false, peers: [] });

interface StatusNode {
  TailscaleIPs?: unknown;
  Online?: unknown;
}

/** Read `tailscale status --json`: online peers' IPv4 addresses; not running unless its state is `Running`. */
export function parseTailscaleStatus(json: unknown): Tailnet {
  if (typeof json !== "object" || json === null) return NO_TAILNET;
  const status = json as { BackendState?: unknown; Peer?: unknown };
  if (status.BackendState !== "Running") return NO_TAILNET;
  const peers = typeof status.Peer === "object" && status.Peer !== null ? (Object.values(status.Peer) as StatusNode[]) : [];
  const addresses = peers
    .filter((p) => p.Online === true && Array.isArray(p.TailscaleIPs))
    .flatMap((p) => (p.TailscaleIPs as unknown[]).filter((ip): ip is string => typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip)));
  return { running: true, peers: [...new Set(addresses)] };
}

/** Whether an IPv4 address is in Tailscale's range (100.64.0.0/10). */
export function isTailnetAddress(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** Which way an answer came, from its sender's address (an IPv4-mapped IPv6 one too). */
export function replySource(from: string): "lan" | "tailnet" {
  return isTailnetAddress(from.replace(/^::ffff:/, "")) ? "tailnet" : "lan";
}

/** Run `tailscale status --json`; resolves to its output, or undefined when Tailscale isn't there or doesn't answer. */
export type StatusReader = () => Promise<string | undefined>;

const readStatus: StatusReader = () =>
  new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : stdout));
  });

/** This machine's tailnet; `NO_TAILNET` when Tailscale isn't installed, stopped, or logged out. */
export async function tailnet(read: StatusReader = readStatus): Promise<Tailnet> {
  const out = await read();
  if (!out) return NO_TAILNET;
  try {
    return parseTailscaleStatus(JSON.parse(out));
  } catch {
    return NO_TAILNET;
  }
}
