import { randomBytes } from "node:crypto";

/** How long a sign-in link works. */
export const SIGN_IN_CODE_TTL_MS = 10 * 60_000;
/** Codes waiting to be used at once; creating more drops the oldest. */
const MAX_OUTSTANDING = 20;

/**
 * One-time codes for signing a browser in to the console without typing the ASO token. A code
 * works once, for a few minutes, so a link that leaks (browser history, a chat, a screenshot) is
 * useless afterwards; the token itself never appears in a URL.
 */
export class SignInCodes {
  private readonly codes = new Map<string, number>();

  constructor(private readonly ttlMs = SIGN_IN_CODE_TTL_MS) {}

  create(now = Date.now()): { code: string; expiresAt: string } {
    this.prune(now);
    while (this.codes.size >= MAX_OUTSTANDING) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(18).toString("base64url");
    const expiresAt = now + this.ttlMs;
    this.codes.set(code, expiresAt);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** True once for a valid, unexpired code; the code is gone afterwards either way. */
  redeem(code: unknown, now = Date.now()): boolean {
    if (typeof code !== "string") return false;
    const expiresAt = this.codes.get(code);
    this.codes.delete(code);
    return expiresAt !== undefined && expiresAt > now;
  }

  private prune(now: number): void {
    for (const [code, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(code);
  }
}
