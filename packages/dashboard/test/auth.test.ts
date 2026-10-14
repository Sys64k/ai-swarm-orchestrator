import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserOrigin, isPublicPath, isSameOrigin, isSignedIn, redirectTo, safeNext } from "../lib/auth.ts";
import { errorMessage, hubPath } from "../lib/hub-routes.ts";

describe("console sign-in", () => {
  const token = "aso_secret-token";
  const basic = (pw: string) => `Basic ${btoa(`any:${pw}`)}`;

  it("accepts the session cookie or Basic auth with the token", () => {
    assert.ok(isSignedIn(token, token, null));
    assert.ok(isSignedIn(token, undefined, basic(token)));
    assert.ok(!isSignedIn(token, "wrong", null));
    assert.ok(!isSignedIn(token, undefined, basic("wrong")));
    assert.ok(!isSignedIn(token, undefined, "Basic %%%not-base64"));
    assert.ok(!isSignedIn(token, undefined, `Bearer ${token}`), "the Hub's bearer form is not a browser credential");
    assert.ok(!isSignedIn(token, undefined, null));
    assert.ok(isSignedIn(undefined, undefined, null), "open when the Hub runs without a token");
  });

  it("only redirects to paths on this site after signing in", () => {
    assert.equal(safeNext("/tasks/a?x=1"), "/tasks/a?x=1");
    assert.equal(safeNext("//evil.example/x"), "/");
    assert.equal(safeNext("/\\evil.example"), "/");
    assert.equal(safeNext("https://evil.example"), "/");
    assert.equal(safeNext(undefined), "/");
  });

  it("redirects to the address the browser used, not the one the server binds to", () => {
    const phone = new Headers({ host: "192.168.101.127:7421" });
    assert.equal(browserOrigin(phone, "http://localhost:7421"), "http://192.168.101.127:7421");
    const proxied = new Headers({ host: "127.0.0.1:7421", "x-forwarded-host": "agent007.tail1234.ts.net", "x-forwarded-proto": "https" });
    assert.equal(browserOrigin(proxied, "http://localhost:7421"), "https://agent007.tail1234.ts.net");
    assert.equal(browserOrigin(new Headers(), "http://localhost:7421"), "http://localhost:7421");
    const r = redirectTo("/login?next=%2F", phone, "http://localhost:7421", 307);
    assert.equal(r.status, 307);
    assert.equal(r.headers.get("location"), "http://192.168.101.127:7421/login?next=%2F");
  });

  it("accepts POSTs only from the console's own pages", () => {
    assert.ok(isSameOrigin("http://192.168.101.127:7421", "192.168.101.127:7421"));
    assert.ok(isSameOrigin(null, "192.168.101.127:7421"), "no Origin header");
    assert.ok(!isSameOrigin("http://evil.example", "192.168.101.127:7421"));
    assert.ok(!isSameOrigin("not a url", "192.168.101.127:7421"));
  });

  it("keeps everything but sign-in and static assets behind the token", () => {
    for (const p of ["/login", "/api/session", "/manifest.webmanifest", "/icon.svg", "/_next/static/x.js"]) assert.ok(isPublicPath(p), p);
    for (const p of ["/", "/tasks/a", "/api/hub/tasks", "/loginx", "/api/sessions"]) assert.ok(!isPublicPath(p), p);
  });
});

describe("Hub proxy allowlist", () => {
  it("allows the console's reads and actions", () => {
    assert.equal(hubPath("GET", ["tasks"]), "/api/tasks");
    assert.equal(hubPath("GET", ["tasks", "api-1", "transcript"]), "/api/tasks/api-1/transcript");
    assert.equal(hubPath("POST", ["tasks", "api-1", "retry"]), "/api/tasks/api-1/retry");
    assert.equal(hubPath("POST", ["tasks", "api-1", "cancel"]), "/api/tasks/api-1/cancel");
    assert.equal(hubPath("POST", ["plans"]), "/api/plans");
    assert.equal(hubPath("POST", ["plans", "plan-1", "approve"]), "/api/plans/plan-1/approve");
    assert.equal(hubPath("GET", ["nodes"]), "/api/nodes");
  });

  it("refuses everything else", () => {
    assert.equal(hubPath("POST", ["tasks"]), undefined, "no raw task submission from the browser");
    assert.equal(hubPath("GET", ["sync"]), undefined);
    assert.equal(hubPath("POST", ["sync"]), undefined);
    assert.equal(hubPath("GET", ["tasks", "..", "..", "git"]), undefined);
    assert.equal(hubPath("GET", ["tasks", "a", "transcript", "x"]), undefined);
    assert.equal(hubPath("DELETE", ["tasks", "a"]), undefined);
    assert.equal(hubPath("GET", ["tasks", "a/b"]), undefined);
  });
});

describe("error messages", () => {
  it("prefers the API's error text and falls back to the status", () => {
    assert.equal(errorMessage(409, { error: "task a is already merged" }), "task a is already merged");
    assert.equal(errorMessage(502, null), "HTTP 502");
    assert.equal(errorMessage(500, { error: "" }), "HTTP 500");
    assert.equal(errorMessage(500, "<html>"), "HTTP 500");
  });
});
