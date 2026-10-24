import { randomBytes, timingSafeEqual } from "node:crypto";

/** Shared secret all nodes, the CLI and the dashboard present to the Hub. */
export function generateToken(): string {
  return `aso_${randomBytes(24).toString("base64url")}`;
}

export function authorizationHeader(token: string): string {
  return `Bearer ${token}`;
}

/** Constant-time comparison so response timing doesn't reveal how much of a guess matched. */
export function tokensEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accepts `Authorization: Bearer <token>` (nodes, CLI) or HTTP Basic with the token as the
 * password (git and browsers, which only speak Basic).
 */
export function isAuthorized(header: string | undefined | null, token: string): boolean {
  const given = credentialOf(header);
  return given !== undefined && tokensEqual(given, token);
}

/** The secret in an `Authorization` header: a Bearer token, or a Basic password. */
export function credentialOf(header: string | undefined | null): string | undefined {
  if (!header) return undefined;
  const [scheme, value = ""] = header.split(" ", 2);
  if (/^bearer$/i.test(scheme)) return value.trim();
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
    return decoded.slice(decoded.indexOf(":") + 1);
  }
  return undefined;
}

/** Worker keys (one per worker machine, revocable) start with this; the Hub's own token with `aso_`. */
export const WORKER_KEY_PREFIX = "asow_";

/**
 * Whether traffic to `ip` stays private without TLS: loopback, the private LAN ranges, link-local,
 * and Tailscale's range (100.64.0.0/10, which WireGuard encrypts). Anything else is the internet.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  // ::1, unique local (fc00::/7, Tailscale's fd7a:115c:a1e0::/48 among them) and link-local (fe80::/10).
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}
