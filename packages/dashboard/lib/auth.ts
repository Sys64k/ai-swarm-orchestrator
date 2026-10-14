/** Console sign-in: the ASO token, kept in an httpOnly cookie so page scripts never see it. */

export const SESSION_COOKIE = "aso_session";
/** Browsers cap cookie lifetime at 400 days. */
export const SESSION_MAX_AGE_SEC = 400 * 24 * 60 * 60;

export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Whether a request carries the token: the session cookie, or HTTP Basic auth (any user name,
 * the token as password) for scripts and older bookmarks. No token configured means open.
 */
export function isSignedIn(token: string | undefined, cookie: string | undefined, authorization: string | null): boolean {
  if (!token) return true;
  if (cookie && constantTimeEqual(cookie, token)) return true;
  if (authorization?.startsWith("Basic ")) {
    let decoded: string;
    try {
      decoded = atob(authorization.slice(6));
    } catch {
      return false;
    }
    return constantTimeEqual(decoded.slice(decoded.indexOf(":") + 1), token);
  }
  return false;
}

/** A POST from our own pages: no Origin header (same-origin form posts in some browsers) or a matching host. */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Only same-site relative paths, so a crafted login link can't send someone elsewhere. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/**
 * The origin the browser used. Next.js builds `request.url` from the address it binds to
 * (e.g. localhost), so redirects built from it would send a phone on the LAN to the wrong host
 * and lose its session cookie. The Host header (or a proxy's X-Forwarded-*) is what it typed.
 */
export function browserOrigin(headers: Headers, fallback: string): string {
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return fallback;
  const proto = headers.get("x-forwarded-proto") ?? new URL(fallback).protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** Redirect to a path on the address the browser used. */
export function redirectTo(path: string, headers: Headers, fallbackOrigin: string, status = 303): Response {
  return new Response(null, { status, headers: { location: new URL(path, browserOrigin(headers, fallbackOrigin)).href } });
}

/** Routes that work without signing in. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/session" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/icon.svg" ||
    pathname.startsWith("/_next/")
  );
}
