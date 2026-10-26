import { Hono, type Context } from "hono";
import type { WSEvents } from "hono/ws";
import { createNodeWebSocket } from "@hono/node-ws";
import { getConnInfo } from "@hono/node-server/conninfo";
import { GIT_PATH, WS_PATH } from "@aso/shared";

/**
 * The worker gateway: a second listener for machines that reach the Hub from the internet
 * (through a TLS tunnel such as Tailscale Funnel). It serves only what a remote worker needs and
 * never accepts the Hub's main token, so the API and the console stay off the internet. Every
 * rule is in this file.
 */

/** Where a machine joins with a one-time code. */
export const JOIN_PATH = "/api/worker-keys/join";
/** API paths anyone may call on the Hub's own port (the Hub's allow-list uses this too). */
export const PUBLIC_API_PATHS = ["/api/health", "/api/version", "/api/openapi.json", JOIN_PATH] as const;
/** The public ones the gateway serves: not the API description, which a worker doesn't need. */
const GATEWAY_PUBLIC = new Set(["GET /api/health", "GET /api/version", "GET /dist/aso.tgz", `POST ${JOIN_PATH}`]);

/** Failed keys or join codes one address may try per window before it is refused. */
export const GATEWAY_MAX_FAILURES = 20;
export const GATEWAY_FAILURE_WINDOW_MS = 10 * 60_000;

/** How the gateway treats a request; undefined: not served there (404). */
export interface GatewayRule {
  /** `public`: no credential; `worker`: a worker key, never the main token. */
  access: "public" | "worker";
  /** A failed answer (a wrong join code) counts against the client's address. */
  countsFailure?: boolean;
}

/** The rule for a request on the gateway, by method and path. */
export function gatewayAccess(method: string, path: string): GatewayRule | undefined {
  if (GATEWAY_PUBLIC.has(`${method} ${path}`)) return path === JOIN_PATH ? { access: "public", countsFailure: true } : { access: "public" };
  if (method === "GET" && path === WS_PATH) return { access: "worker" };
  if ((method === "GET" || method === "POST") && path.startsWith(`${GIT_PATH}/`)) return { access: "worker" };
  return undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The client's address: the socket's, or, when the request comes from a proxy on this machine
 * (the tunnel), the last address in its X-Forwarded-For: the one that proxy saw. That assumes a
 * single proxy hop on this machine, as with Tailscale Funnel. A remote client can't fake it,
 * since only a local proxy's header is trusted.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined): string {
  const socket = remote ?? "unknown";
  if (!LOOPBACK.has(socket) || !forwardedFor) return socket;
  const last = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  return last ?? socket;
}

/** A request's client address (see `clientAddress`). */
export function requestAddress(c: Context): string {
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    remote = undefined; // not on a Node socket (tests calling app.request)
  }
  return clientAddress(remote, c.req.header("x-forwarded-for"));
}

/** Failed attempts per address in a sliding window; an address over the limit is refused until it passes. */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private recent(address: string, now: number): number[] {
    const kept = (this.failures.get(address) ?? []).filter((t) => now - t < this.windowMs);
    if (kept.length) this.failures.set(address, kept);
    else this.failures.delete(address);
    return kept;
  }

  blocked(address: string, now = Date.now()): boolean {
    return this.recent(address, now).length >= this.max;
  }

  fail(address: string, now = Date.now()): void {
    this.failures.set(address, [...this.recent(address, now), now]);
  }
}

export interface GatewayDeps {
  /** The Hub's own app: allowed requests go there, with its handlers and checks. */
  app: Hono;
  /** The worker connection's events, as on the Hub's own port. */
  workerSocket: (c: Context) => WSEvents;
  /** Whether the request carries an active worker key (the main token doesn't count). */
  hasWorkerKey: (c: Context) => boolean;
}

/**
 * The gateway's app, in order: refuse an address with too many failures; serve only what
 * `gatewayAccess` allows; worker paths need a worker key; count failures. Returns it with the
 * function that attaches its WebSocket upgrades to the listener.
 */
export function createGatewayApp(deps: GatewayDeps): { app: Hono; injectWebSocket: ReturnType<typeof createNodeWebSocket>["injectWebSocket"] } {
  const gw = new Hono();
  // Its own WebSocket helper: node-ws hands every upgrade on a server to the app it was made
  // with, and the Hub's app would also take the main token on its socket path.
  const socket = createNodeWebSocket({ app: gw });
  const failures = new AttemptLimiter(GATEWAY_MAX_FAILURES, GATEWAY_FAILURE_WINDOW_MS);
  gw.use("*", async (c, next) => {
    const address = requestAddress(c);
    if (failures.blocked(address)) return c.json({ error: "too many failed attempts from this address; try again later" }, 429);
    const rule = gatewayAccess(c.req.method, c.req.path);
    if (!rule) return c.json({ error: "not served on the worker gateway" }, 404);
    if (rule.access === "worker" && !deps.hasWorkerKey(c)) {
      failures.fail(address);
      c.header("WWW-Authenticate", 'Basic realm="ASO Hub"');
      return c.json({ error: "the worker gateway takes worker keys only" }, 401);
    }
    await next();
    if (rule.countsFailure && c.res.status >= 400 && c.res.status !== 429) failures.fail(address);
  });
  // The worker connection is served here, never passed to the Hub's app (see above).
  gw.get(WS_PATH, socket.upgradeWebSocket(deps.workerSocket));
  gw.all("*", (c) => deps.app.fetch(c.req.raw, c.env));
  return { app: gw, injectWebSocket: socket.injectWebSocket };
}
