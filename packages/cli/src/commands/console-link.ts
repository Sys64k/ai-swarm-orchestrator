import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import QRCode from "qrcode";
import { authorizationHeader, hubHttpBase, resolveToken } from "@aso/shared";

const exec = promisify(execFile);

/** `tailscale serve status --json`, the parts this command reads. */
interface ServeStatus {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/**
 * The console's HTTPS address on the tailnet, if `tailscale serve` proxies to it: the address
 * that works from anywhere, so it's the one worth putting in a link.
 */
export function tailscaleConsoleUrl(status: ServeStatus, dashboardPort: number): string | undefined {
  for (const [hostPort, web] of Object.entries(status.Web ?? {})) {
    const proxied = Object.values(web.Handlers ?? {}).some((h) => h.Proxy && new URL(h.Proxy).port === String(dashboardPort));
    if (!proxied) continue;
    const [host, port] = hostPort.split(":");
    return port === "443" ? `https://${host}` : `https://${host}:${port}`;
  }
  return undefined;
}

/** The console on this machine's LAN address: a private IPv4, never Docker's bridges. */
export function lanConsoleUrl(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>, dashboardPort: number): string | undefined {
  const candidates = Object.entries(interfaces)
    .filter(([name]) => !/^(docker|br-|veth|virbr|tailscale|lo)/.test(name))
    .flatMap(([, addrs]) => addrs ?? [])
    .filter((a) => a.family === "IPv4" && !a.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address));
  return candidates[0] ? `http://${candidates[0].address}:${dashboardPort}` : undefined;
}

async function serveStatus(): Promise<ServeStatus> {
  try {
    return JSON.parse((await exec("tailscale", ["serve", "status", "--json"], { timeout: 5000 })).stdout) as ServeStatus;
  } catch {
    return {};
  }
}

/** Print a one-time console sign-in link (and its QR code) for another device. */
export async function consoleLinkCommand(opts: { hub: string; url?: string; dashboardPort: number; qr: boolean }): Promise<void> {
  const base =
    opts.url?.replace(/\/+$/, "") ??
    tailscaleConsoleUrl(await serveStatus(), opts.dashboardPort) ??
    lanConsoleUrl(os.networkInterfaces(), opts.dashboardPort) ??
    `http://localhost:${opts.dashboardPort}`;

  const hub = hubHttpBase(opts.hub);
  const api = `${hub}/api/sign-in-codes`;
  const token = resolveToken()?.token;
  const res = await fetch(api, { method: "POST", headers: token ? { authorization: authorizationHeader(token) } : {} }).catch(() => {
    throw new Error(`cannot reach the Hub at ${hub} (is it running? use --hub)`);
  });
  if (res.status === 401) throw new Error("the Hub rejected the ASO token (run this on the Hub machine, or set ASO_TOKEN)");
  if (!res.ok) throw new Error(`the Hub returned HTTP ${res.status}`);
  const { code, expiresAt } = (await res.json()) as { code: string; expiresAt: string };

  const link = new URL("/login", base);
  link.searchParams.set("code", code);
  if (opts.qr) console.log(await QRCode.toString(link.href, { type: "terminal", small: true }));
  console.log(link.href);
  console.log(`\nOpens the console signed in, once, until ${new Date(expiresAt).toLocaleTimeString()}.`);
}

