import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hubPath } from "../lib/hub-routes.ts";
import { isPublicPath } from "../lib/auth.ts";
import { base64UrlToBytes, detectPushEnvironment, enablePush, pushSetup, sameKey, subscribeProblem, type EnableDeps, type PushEnvironment, type PushProbe } from "../lib/push.ts";

const capable: PushEnvironment = { secure: true, serviceWorker: true, pushManager: true, notification: true, permission: "default", ios: false, standalone: false };

describe("pushSetup", () => {
  it("is ready on a capable browser over https", () => {
    assert.equal(pushSetup(capable).kind, "ready");
    assert.equal(pushSetup({ ...capable, permission: "granted" }).kind, "ready");
  });

  it("explains what stands in the way", () => {
    assert.equal(pushSetup({ ...capable, secure: false }).kind, "needs-https", "plain http on the LAN");
    assert.equal(pushSetup({ ...capable, secure: false, serviceWorker: false }).kind, "needs-https", "http hides the APIs; https is the fix");
    assert.equal(pushSetup({ ...capable, ios: true }).kind, "needs-install");
    assert.equal(pushSetup({ ...capable, ios: true, standalone: true }).kind, "ready");
    assert.equal(pushSetup({ ...capable, pushManager: false }).kind, "unsupported");
    assert.equal(pushSetup({ ...capable, permission: "denied" }).kind, "blocked");
  });
});

describe("subscribeProblem", () => {
  it("explains the browser's cryptic refusals and passes other messages through", () => {
    assert.match(subscribeProblem("Registration failed - permission denied"), /incognito/);
    assert.match(subscribeProblem("Registration failed - push service error"), /couldn't reach its push service/);
    assert.equal(subscribeProblem("something else"), "something else");
  });
});

describe("push keys", () => {
  it("decodes the Hub's URL-safe base64 key", () => {
    const bytes = base64UrlToBytes(Buffer.from([0xfb, 0xff, 0x00, 0x04, 0x3e]).toString("base64url"));
    assert.deepEqual([...bytes], [0xfb, 0xff, 0x00, 0x04, 0x3e]);
  });

  it("tells whether a subscription belongs to the current key", () => {
    const key = new Uint8Array([1, 2, 3]);
    assert.ok(sameKey(new Uint8Array([1, 2, 3]).buffer, key));
    assert.ok(!sameKey(new Uint8Array([1, 2, 4]).buffer, key));
    assert.ok(!sameKey(new Uint8Array([1, 2]).buffer, key));
    assert.ok(!sameKey(null, key));
  });
});

describe("console access to push", () => {
  it("lets the console reach only the push endpoints it uses", () => {
    assert.equal(hubPath("GET", ["push"]), "/api/push");
    assert.equal(hubPath("POST", ["projects", "shop", "deploy"]), "/api/projects/shop/deploy");
    assert.equal(hubPath("GET", ["projects", "shop", "deploy"]), undefined);
    assert.equal(hubPath("GET", ["hub", "update"]), "/api/hub/update");
    assert.equal(hubPath("POST", ["hub", "update"]), undefined, "only the updater on the Hub machine reports");
    assert.equal(hubPath("GET", ["worker-keys"]), "/api/worker-keys");
    assert.equal(hubPath("GET", ["version"]), "/api/version");
    assert.equal(hubPath("POST", ["worker-keys", "join-codes"]), "/api/worker-keys/join-codes");
    assert.equal(hubPath("POST", ["worker-keys", "k1", "revoke"]), "/api/worker-keys/k1/revoke");
    assert.equal(hubPath("POST", ["worker-keys", "join"]), undefined, "joining is for the new machine, not the console");
    for (const p of ["subscriptions", "subscriptions/check", "subscriptions/delete", "test"]) assert.equal(hubPath("POST", ["push", ...p.split("/")]), `/api/push/${p}`);
    assert.equal(hubPath("POST", ["push"]), undefined);
    assert.equal(hubPath("GET", ["push", "subscriptions"]), undefined);
  });

  it("serves the service worker and icons without signing in, but nothing else new", () => {
    for (const p of ["/sw.js", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/badge-96.png"]) assert.ok(isPublicPath(p), p);
    for (const p of ["/notifications", "/sw.jsx", "/icon-192.png.map", "/secret.png"]) assert.ok(!isPublicPath(p), p);
  });
});

describe("detectPushEnvironment", () => {
  const probe: PushProbe = { isSecureContext: true, hasPushManager: true, notificationPermission: "default", hasServiceWorker: true, userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9a)", platform: "Linux armv81", maxTouchPoints: 5, standalone: false };

  it("reads an Android phone as capable", () => {
    assert.deepEqual(detectPushEnvironment(probe), { secure: true, serviceWorker: true, pushManager: true, notification: true, permission: "default", ios: false, standalone: false });
  });

  it("spots iPhones, and iPads that claim to be Macs", () => {
    assert.ok(detectPushEnvironment({ ...probe, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }).ios);
    assert.ok(detectPushEnvironment({ ...probe, userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }).ios);
    assert.ok(!detectPushEnvironment({ ...probe, userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 }).ios, "a real Mac");
  });

  it("treats a missing Notification API as unsupported", () => {
    const env = detectPushEnvironment({ ...probe, notificationPermission: undefined });
    assert.equal(env.notification, false);
    assert.equal(pushSetup(env).kind, "unsupported");
  });
});

describe("enablePush", () => {
  const key = Buffer.from(Array.from({ length: 65 }, (_, i) => i)).toString("base64url");
  const fakeSub = (keyBytes: number[], log: string[]) =>
    ({
      options: { applicationServerKey: new Uint8Array(keyBytes).buffer },
      unsubscribe: async () => (log.push("unsubscribe"), true),
      toJSON: () => ({ endpoint: "https://push/new" }),
    }) as unknown as PushSubscription;

  const deps = (over: Partial<EnableDeps> & { existing?: PushSubscription | null; subscribeError?: string } = {}) => {
    const log: string[] = [];
    const d: EnableDeps = {
      requestPermission: async () => "granted",
      hubKey: async () => ({ ok: true, key }),
      pushManager: async () => ({
        getSubscription: async () => over.existing ?? null,
        subscribe: async () => {
          log.push("subscribe");
          if (over.subscribeError) throw new Error(over.subscribeError);
          return fakeSub([], log);
        },
      }) as unknown as PushManager,
      save: async (s) => (log.push(`save ${s.endpoint}`), undefined),
      ...over,
    };
    return { d, log };
  };

  it("subscribes with the Hub's key and registers the device", async () => {
    const { d, log } = deps();
    assert.equal(await enablePush(d), undefined);
    assert.deepEqual(log, ["subscribe", "save https://push/new"]);
  });

  it("re-uses a subscription made with the same key, and replaces one made with another", async () => {
    const same = deps({ existing: fakeSub(Array.from({ length: 65 }, (_, i) => i), []) });
    await enablePush(same.d);
    assert.deepEqual(same.log, ["save https://push/new"]);
    const log: string[] = [];
    const other = deps({ existing: fakeSub([9, 9, 9], log) });
    await enablePush(other.d);
    assert.deepEqual([...log, ...other.log], ["unsubscribe", "subscribe", "save https://push/new"]);
  });

  it("stops with a reason when something is refused", async () => {
    assert.equal(await enablePush(deps({ requestPermission: async () => "denied" }).d), "Notifications were not allowed.");
    assert.equal(await enablePush(deps({ hubKey: async () => ({ ok: false, error: "Hub unreachable" }) }).d), "Hub unreachable");
    assert.match((await enablePush(deps({ subscribeError: "Registration failed - permission denied" }).d))!, /incognito/);
    assert.equal(await enablePush(deps({ save: async () => "keys.auth: must be 16 bytes" }).d), "keys.auth: must be 16 bytes");
  });
});
