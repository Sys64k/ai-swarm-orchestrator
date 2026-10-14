import type { NextRequest } from "next/server";
import { isSameOrigin } from "../../../../lib/auth.ts";
import { hubPath } from "../../../../lib/hub-routes.ts";

const HUB = `http://127.0.0.1:${process.env.ASO_HUB_PORT ?? "7420"}`;

/**
 * The browser's only way to the Hub: allowlisted endpoints, with the ASO token added here on
 * the server so page scripts never hold it.
 */
async function forward(request: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const target = hubPath(request.method, path);
  if (!target) return Response.json({ error: "not available from the console" }, { status: 404 });

  const token = process.env.ASO_TOKEN;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  let body: string | undefined;
  if (request.method === "POST") {
    // Browsers attach Basic-auth credentials even to cross-site requests; only accept our own pages.
    if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
      return Response.json({ error: "cross-site request refused" }, { status: 403 });
    }
    body = await request.text();
    headers["content-type"] = "application/json";
  }
  try {
    const res = await fetch(`${HUB}${target}${request.nextUrl.search}`, { method: request.method, headers, body, cache: "no-store" });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: `Hub unreachable at ${HUB}` }, { status: 502 });
  }
}

export const GET = forward;
export const POST = forward;
