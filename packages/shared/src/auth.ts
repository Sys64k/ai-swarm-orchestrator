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
  if (!header) return false;
  const [scheme, value = ""] = header.split(" ", 2);
  if (/^bearer$/i.test(scheme)) return tokensEqual(value.trim(), token);
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(value.trim(), "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return tokensEqual(password, token);
  }
  return false;
}
