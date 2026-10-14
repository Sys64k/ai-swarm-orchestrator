import { NextResponse, type NextRequest } from "next/server";
import { isPublicPath, isSignedIn, redirectTo, SESSION_COOKIE } from "./lib/auth.ts";

/**
 * Everything but the sign-in page needs the ASO token: the session cookie set by signing in,
 * or HTTP Basic auth. Pages redirect to /login; API calls get 401.
 * Without ASO_TOKEN (Hub started with authentication disabled) the console is open.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (isSignedIn(process.env.ASO_TOKEN, request.cookies.get(SESSION_COOKIE)?.value, request.headers.get("authorization"))) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  return redirectTo(`/login?next=${encodeURIComponent(pathname + search)}`, request.headers, request.nextUrl.origin, 307);
}

export const config = { matcher: "/:path*" };
