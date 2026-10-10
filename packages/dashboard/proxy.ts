import { NextResponse, type NextRequest } from "next/server";

/**
 * Browser access needs the ASO token: HTTP Basic auth, any user name, the token as password.
 * Without ASO_TOKEN (Hub started with authentication disabled) the dashboard is open.
 */
export function proxy(request: NextRequest) {
  const token = process.env.ASO_TOKEN;
  if (!token) return NextResponse.next();
  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = atob(header.slice(6));
    if (constantTimeEqual(decoded.slice(decoded.indexOf(":") + 1), token)) return NextResponse.next();
  }
  return new NextResponse("ASO dashboard: sign in with any user name and the ASO token as the password.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ASO dashboard", charset="UTF-8"' },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const config = { matcher: "/:path*" };
