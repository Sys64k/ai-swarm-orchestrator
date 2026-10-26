import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { AttemptLimiter, clientAddress, gatewayAccess, JOIN_PATH, PUBLIC_API_PATHS } from "@aso/hub";
import { connect, tempDir, TOKEN, withHub } from "./helpers.ts";

describe("worker gateway: what it serves", () => {
  it("serves only what a remote worker needs", () => {
    assert.deepEqual(gatewayAccess("GET", "/ws"), { access: "worker" });
    assert.deepEqual(gatewayAccess("GET", "/git/project.git/info/refs"), { access: "worker" });
    assert.deepEqual(gatewayAccess("POST", "/git/project.git/git-receive-pack"), { access: "worker" });
    assert.deepEqual(gatewayAccess("GET", "/api/health"), { access: "public" });
    assert.deepEqual(gatewayAccess("GET", "/api/version"), { access: "public" });
    assert.deepEqual(gatewayAccess("GET", "/dist/aso.tgz"), { access: "public" });
    assert.deepEqual(gatewayAccess("POST", "/api/worker-keys/join"), { access: "public", countsFailure: true }, "a wrong join code counts against the address");
    for (const path of PUBLIC_API_PATHS) {
      if (path !== "/api/openapi.json") assert.ok(gatewayAccess(path === JOIN_PATH ? "POST" : "GET", path), `${path} is public on the Hub, and served on the gateway`);
    }
    for (const [method, path] of [
      ["GET", "/api/tasks"],
      ["POST", "/api/worker-keys/join-codes"],
      ["POST", "/api/providers"],
      ["GET", "/api/openapi.json"],
      ["POST", "/api/sign-in-codes/redeem"],
      ["DELETE", "/git/project.git"],
      ["GET", "/gitx"],
    ]) {
      assert.equal(gatewayAccess(method, path), undefined, `${method} ${path}`);
    }
  });

  it("trusts X-Forwarded-For only from a proxy on this machine", () => {
    assert.equal(clientAddress("127.0.0.1", "198.51.100.7"), "198.51.100.7", "the tunnel's header");
    assert.equal(clientAddress("::1", "10.0.0.1, 198.51.100.7"), "198.51.100.7", "the last hop is the tunnel's");
    assert.equal(clientAddress("203.0.113.9", "127.0.0.1"), "203.0.113.9", "a remote client can't claim another address");
    assert.equal(clientAddress("127.0.0.1", undefined), "127.0.0.1");
    assert.equal(clientAddress(undefined, undefined), "unknown");
  });

  it("refuses an address with too many failures until the window passes", () => {
    const limiter = new AttemptLimiter(3, 1000);
    for (let i = 0; i < 3; i++) limiter.fail("a", 100);
    assert.equal(limiter.blocked("a", 200), true);
    assert.equal(limiter.blocked("b", 200), false, "other addresses aren't affected");
    assert.equal(limiter.blocked("a", 1200), false, "the window passed");
  });
});

const call = (port: number, route: string, init: { method?: string; auth?: string | null; body?: unknown; forwardedFor?: string } = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.auth === null ? {} : { authorization: `Bearer ${init.auth ?? TOKEN}` }),
      ...(init.forwardedFor ? { "x-forwarded-for": init.forwardedFor } : {}),
      "content-type": "application/json",
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));

const clone = (port: number, credential: string) =>
  promisify(execFile)("git", ["clone", "--quiet", `http://x-access-token:${credential}@127.0.0.1:${port}/git/project.git`, "."], {
    cwd: tempDir(),
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

describe("worker gateway (Hub)", () => {
  it("lets a worker join, clone and connect with its key, and never takes the main token", async () => {
    await withHub(
      async (ctx) => {
        const gw = ctx.hub.gatewayPort!;
        assert.ok(gw && gw !== ctx.port, "a port of its own");

        assert.equal((await call(gw, "/api/tasks")).status, 404, "the API isn't there, even with the main token");
        assert.equal((await call(gw, "/api/worker-keys/join-codes", { method: "POST", body: {} })).status, 404, "nor making join codes");
        assert.equal((await call(gw, "/api/health", { auth: null })).status, 200);

        const code = (await call(ctx.port, "/api/worker-keys/join-codes", { method: "POST", body: { name: "remote" } })).body.code as string;
        const joined = await call(gw, "/api/worker-keys/join", { method: "POST", auth: null, body: { code, machine: "remote" } });
        assert.equal(joined.status, 201, JSON.stringify(joined.body));
        const key = joined.body.key as string;

        await clone(gw, key);
        await assert.rejects(clone(gw, TOKEN), "Git with the main token is refused on the gateway");
        assert.equal((await call(gw, "/git/project.git/info/refs?service=git-upload-pack", { auth: TOKEN })).status, 401);

        const remote = await connect(gw, key);
        remote.ws.close();
        await assert.rejects(connect(gw, TOKEN), "the worker connection with the main token is refused");
        await clone(ctx.port, TOKEN); // the Hub's own port is unchanged
      },
      { gateway: { port: 0 } },
    );
  });

  it("slows down an address that keeps guessing keys, not the others", async () => {
    await withHub(
      async (ctx) => {
        const gw = ctx.hub.gatewayPort!;
        const guess = (forwardedFor: string) => call(gw, "/git/project.git/info/refs?service=git-upload-pack", { auth: "asow_guess", forwardedFor });
        for (let i = 0; i < 20; i++) assert.equal((await guess("198.51.100.7")).status, 401);
        assert.equal((await guess("198.51.100.7")).status, 429, "too many failures from that address");
        assert.equal((await call(gw, "/api/health", { auth: null, forwardedFor: "198.51.100.7" })).status, 429, "everything, for a while");
        assert.equal((await guess("203.0.113.9")).status, 401, "another address isn't blocked");
      },
      { gateway: { port: 0 } },
    );
  });

  it("hands its public address out with join codes, for machines joining from the internet", async () => {
    await withHub(
      async (ctx) => {
        const made = await call(ctx.port, "/api/worker-keys/join-codes", { method: "POST", body: {} });
        assert.equal(made.body.gatewayUrl, "wss://agent007.example.ts.net:10000");
      },
      { gateway: { port: 0, url: "wss://agent007.example.ts.net:10000" } },
    );
    await withHub(async (ctx) => {
      const made = await call(ctx.port, "/api/worker-keys/join-codes", { method: "POST", body: {} });
      assert.equal(made.body.gatewayUrl, undefined, "none without one");
    });
  });

  it("isn't there unless asked for", async () => {
    await withHub(async (ctx) => assert.equal(ctx.hub.gatewayPort, undefined));
  });
});
