import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  encryptPayload,
  generateVapidKeys,
  MAX_PAYLOAD_BYTES,
  notableChanges,
  Notifier,
  sendPush,
  startHub,
  vapidAuthorization,
  type PlanRecord,
  type PushNotification,
  type PushResult,
  type TaskRecord,
} from "@aso/hub";
import { createMessage, parseBody, PushSubscriptionSchema, type PushSubscriptionJson } from "@aso/shared";
import { connect, git, makeTargetRepo, tempDir, TOKEN, waitFor, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY;

const b64 = (s: string) => Buffer.from(s, "base64url");

/** A browser's side of a subscription: its key pair and auth secret. */
function browser(endpoint = "https://push.example.com/send/abc") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSubscriptionJson = { endpoint, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  return { ecdh, auth, sub };
}

/** What the browser does with a push message body (RFC 8291 receiver side). */
function decrypt(body: Buffer, ecdh: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const hkdf = (ikm: Buffer, s: Buffer, info: Buffer, n: number) => Buffer.from(hkdfSync("sha256", ikm, s, info, n));
  const ikm = hkdf(ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32);
  const decipher = createDecipheriv("aes-128-gcm", hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 0x02, "last-record delimiter");
  return plain.subarray(0, -1).toString();
}

describe("web push encryption", () => {
  it("matches the RFC 8291 example", () => {
    const server = createECDH("prime256v1");
    server.setPrivateKey(b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));
    const body = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      {
        endpoint: "https://push.example.net/push/JzLQ3raZJfFBR0aqvOMsLrt54w4rJUsV",
        keys: { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
      },
      { serverKeys: server, salt: b64("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    assert.equal(
      body.toString("base64url"),
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  it("produces messages the subscribing browser can decrypt, and refuses oversized ones", () => {
    const b = browser();
    const body = encryptPayload(Buffer.from('{"title":"hi"}'), b.sub);
    assert.equal(decrypt(body, b.ecdh, b.auth), '{"title":"hi"}');
    assert.throws(() => encryptPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), b.sub), /max/);
  });

  it("signs a VAPID token for the push service's origin", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/xyz", keys, "mailto:me@example.com", 1_000_000_000_000);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    assert.equal(k, keys.publicKey);
    const [h, c, sig] = jwt.split(".");
    const claims = JSON.parse(b64(c).toString());
    assert.deepEqual(claims, { aud: "https://fcm.googleapis.com", exp: 1_000_000_000 + 12 * 3600, sub: "mailto:me@example.com" });
    const raw = b64(keys.publicKey);
    const pub = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: "ieee-p1363" }, b64(sig)));
  });

  it("posts the encrypted message and reports gone subscriptions", async () => {
    const b = browser();
    const keys = generateVapidKeys();
    let seen: { url: string; headers: Record<string, string>; body: Buffer } | undefined;
    const ok = await sendPush(b.sub, { title: "t" }, keys, {
      subject: "mailto:x@y.z",
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) };
        return new Response(null, { status: 201 });
      }) as typeof fetch,
    });
    assert.deepEqual(ok, { ok: true });
    assert.equal(seen!.url, b.sub.endpoint);
    assert.equal(seen!.headers["content-encoding"], "aes128gcm");
    assert.match(seen!.headers.authorization, /^vapid t=/);
    assert.equal(decrypt(seen!.body, b.ecdh, b.auth), '{"title":"t"}');

    const status = (s: number) => sendPush(b.sub, {}, keys, { subject: "mailto:x@y.z", fetch: (async () => new Response("nope", { status: s })) as typeof fetch });
    assert.deepEqual(await status(410), { ok: false, status: 410, error: "push service answered 410: nope", gone: true });
    assert.equal(((await status(500)) as { gone: boolean }).gone, false);
    const down = await sendPush(b.sub, {}, keys, { subject: "mailto:x@y.z", fetch: (async () => Promise.reject(new Error("ENOTFOUND"))) as typeof fetch });
    assert.deepEqual(down, { ok: false, error: "ENOTFOUND", gone: false });
  });
});

const task = (id: string, state: TaskRecord["state"], extra: Partial<TaskRecord> = {}) =>
  ({ spec: { taskId: id, title: `Title ${id}` }, project: "shop", state, ...extra }) as TaskRecord;
const plan = (id: string, state: PlanRecord["state"], extra: Partial<PlanRecord> = {}) =>
  ({ planId: id, project: "shop", requirement: `Build ${id}\nmore detail`, state, ...extra }) as PlanRecord;

describe("notableChanges", () => {
  it("stays quiet about what it sees for the first time", () => {
    const seen = new Map<string, string>();
    assert.deepEqual(notableChanges(seen, { id: "shop", tasks: [task("a", "failed")], plans: [plan("p", "proposed")] }), []);
    assert.deepEqual(notableChanges(seen, { id: "shop", tasks: [task("a", "failed")], plans: [plan("p", "proposed")] }), [], "nor about what didn't change");
  });

  it("announces plans to approve, failures and finished work", () => {
    const seen = new Map<string, string>();
    const look = (tasks: TaskRecord[], plans: PlanRecord[]) => notableChanges(seen, { id: "shop", tasks, plans });
    const taskIds = { api: "t1", ui: "t2" };
    look([task("t1", "in_progress"), task("t2", "pending"), task("solo", "testing")], [plan("p", "planning"), plan("q", "planning")]);

    const proposed = look([], [plan("p", "proposed", { tasks: [{}, {}] as PlanRecord["tasks"] }), plan("q", "failed", { error: "no architect" })]);
    assert.deepEqual(proposed, [
      { title: "shop: plan ready for approval", body: "Build p\n2 tasks proposed", url: "/plans/p", tag: "plan-p" },
      { title: "shop: planning failed", body: "Build q\nno architect", url: "/plans/q", tag: "plan-q" },
    ]);

    const plans = [plan("p", "approved", { taskIds })];
    assert.deepEqual(look([task("t1", "failed", { detail: "tests fail" }), task("t2", "pending")], plans), [
      { title: "shop: task failed", body: "Title t1\ntests fail", url: "/tasks/t1", tag: "task-t1" },
    ]);
    assert.deepEqual(look([task("t1", "merged"), task("t2", "pending")], plans), [], "half of the plan is not done");
    assert.deepEqual(look([task("t1", "merged"), task("t2", "merged"), task("solo", "merged")], plans), [
      { title: "shop: plan done", body: "Build p\nAll 2 tasks merged", url: "/plans/p", tag: "plan-p" },
      { title: "shop: task merged", body: "Title solo", url: "/tasks/solo", tag: "task-solo" },
    ]);
  });

  it("tells you when the Architect has questions", () => {
    const seen = new Map([["plan:p", "planning"]]);
    assert.deepEqual(notableChanges(seen, { id: "shop", tasks: [], plans: [plan("p", "awaiting_input", { questions: ["Which DB?", "Who sees it?"] })] }), [
      { title: "shop: the Architect has questions", body: "Build p\nWhich DB?", url: "/plans/p", tag: "plan-p" },
    ]);
  });

  it("keeps notification text short", () => {
    const seen = new Map([["task:t", "in_progress"]]);
    const [n] = notableChanges(seen, { id: "shop", tasks: [task("t", "failed", { detail: "x".repeat(5000) })], plans: [] });
    assert.ok(n.body.length <= 600 && n.body.endsWith("…"));
  });
});

describe("Notifier", () => {
  const stub = () => {
    const calls: Array<{ endpoint: string; n: PushNotification }> = [];
    const results = new Map<string, PushResult>();
    const send = (async (sub: PushSubscriptionJson, n: PushNotification) => {
      calls.push({ endpoint: sub.endpoint, n });
      return results.get(sub.endpoint) ?? { ok: true };
    }) as unknown as typeof sendPush;
    return { calls, results, send };
  };

  it("keeps its keys and devices across restarts, in a file only the owner can read", async () => {
    const dir = tempDir("aso-push-");
    try {
      const a = await Notifier.open({ dir });
      await a.subscribe(browser("https://push.example.com/1").sub);
      await a.subscribe(browser("https://push.example.com/1").sub); // same device again
      assert.equal(a.subscriptionCount, 1);
      assert.equal(statSync(path.join(dir, "push.json")).mode & 0o777, 0o600);

      const b = await Notifier.open({ dir });
      assert.equal(b.publicKey, a.publicKey);
      assert.ok(b.has("https://push.example.com/1"));
      assert.equal(await b.unsubscribe("https://push.example.com/1"), true);
      assert.equal(await b.unsubscribe("https://push.example.com/1"), false);
      assert.equal((await Notifier.open({ dir })).subscriptionCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets an unreadable file aside instead of failing to start", async () => {
    const dir = tempDir("aso-push-");
    try {
      writeFileSync(path.join(dir, "push.json"), "{not json");
      const n = await Notifier.open({ dir });
      assert.equal(n.subscriptionCount, 0);
      assert.ok(readdirSync(dir).some((f) => f.startsWith("push.json.bad-")), "the broken file is kept for inspection");
      assert.ok(JSON.parse(readFileSync(path.join(dir, "push.json"), "utf8")).vapid.publicKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid subscriptions", () => {
    const good = browser().sub;
    const problem = (v: unknown) => {
      const r = parseBody(PushSubscriptionSchema, v);
      return r.ok ? "" : r.error;
    };
    assert.equal(problem(good), "");
    assert.match(problem(null), /body/);
    assert.match(problem({ ...good, endpoint: "http://push.example.com/x" }), /^endpoint: .*https/);
    assert.match(problem({ ...good, keys: { ...good.keys, auth: "AAAA" } }), /keys.auth: .*16 bytes/);
    assert.match(problem({ ...good, keys: { ...good.keys, p256dh: "not base64!" } }), /base64/);
  });

  it("drops devices the push service says are gone, but keeps ones that failed for other reasons", async () => {
    const s = stub();
    const n = await Notifier.open({ send: s.send });
    for (const i of [1, 2, 3]) await n.subscribe(browser(`https://push.example.com/${i}`).sub);
    s.results.set("https://push.example.com/2", { ok: false, status: 410, error: "gone", gone: true });
    s.results.set("https://push.example.com/3", { ok: false, status: 500, error: "busy", gone: false });
    const msg = { title: "t", body: "b", url: "/", tag: "x" };
    assert.deepEqual(await n.send(msg), { sent: 1, failed: ["gone", "busy"] });
    assert.equal(n.subscriptionCount, 2);
    assert.ok(!n.has("https://push.example.com/2"));

    s.calls.length = 0;
    await n.send(msg, "https://push.example.com/1");
    assert.deepEqual(s.calls.map((c) => c.endpoint), ["https://push.example.com/1"], "a test goes to one device only");
  });
});

describe("push notifications from the Hub", () => {
  const call = (port: number, route: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  it("lets the console subscribe a device, test it, and notifies it as work moves", async () => {
    const root = tempDir("aso-root-");
    const repo = makeTargetRepo();
    git(root, "clone", "--quiet", repo, "shop");
    rmSync(repo, { recursive: true, force: true });
    const sent: Array<{ endpoint: string; n: PushNotification }> = [];
    const send = (async (sub: PushSubscriptionJson, n: PushNotification) => {
      sent.push({ endpoint: sub.endpoint, n });
      return { ok: true };
    }) as unknown as typeof sendPush;
    const hub = await startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false }, push: { send } });
    try {
      const info = await call(hub.port, "/api/push");
      assert.equal(b64(info.body.publicKey).length, 65);
      assert.equal(info.body.devices, 0);
      assert.equal((await call(hub.port, "/api/push/test", {})).status, 404, "nobody to notify yet");

      const phone = browser("https://fcm.googleapis.com/fcm/send/phone");
      assert.equal((await call(hub.port, "/api/push/subscriptions", { endpoint: "https://x" })).status, 400);
      assert.deepEqual((await call(hub.port, "/api/push/subscriptions", phone.sub)).body, { subscribed: true, devices: 1 });
      assert.deepEqual((await call(hub.port, "/api/push/subscriptions/check", { endpoint: phone.sub.endpoint })).body, { subscribed: true });
      assert.deepEqual((await call(hub.port, "/api/push/subscriptions/check", { endpoint: "https://other" })).body, { subscribed: false });
      assert.equal((await call(hub.port, "/api/push/test", { endpoint: "https://other" })).status, 404);
      assert.equal((await call(hub.port, "/api/push/test", { endpoint: 42 })).status, 400);
      assert.equal((await call(hub.port, "/api/push/subscriptions/check", {})).status, 400);
      assert.equal((await call(hub.port, "/api/push/subscriptions/delete", { endpoint: "" })).status, 400);
      assert.deepEqual((await call(hub.port, "/api/push/test", { endpoint: phone.sub.endpoint })).body, { sent: 1, failed: [] });
      assert.equal(sent.pop()!.n.tag, "test");

      // A plan comes back from the Architect: the phone hears about it.
      const created = await call(hub.port, "/api/plans", { requirement: "Add comments", project: "shop" });
      const arch = await connect(hub.port);
      arch.send(createMessage("NODE_REGISTRATION", "arch", { nodeKind: "architect", version: "t" }));
      await arch.next(); // ack
      await arch.next(); // PLAN_REQUEST
      arch.send(createMessage("PLAN_RESULT", "arch", {
        planId: created.body.planId,
        outcome: "proposed",
        summary: "s",
        tasks: [{ key: "c", role: "backend", kind: "feature", title: "Comments", description: "d", acceptanceCriteria: [], files: [], dependsOn: [] }],
      }));
      const ready = await waitFor(() => sent.find((s) => s.n.title === "shop: plan ready for approval"));
      assert.equal(ready.n.url, `/plans/${created.body.planId}`);
      arch.ws.close();

      // A task fails on a worker.
      const w = await worker(hub.port, "dev");
      await call(hub.port, "/api/tasks", { taskId: "api", project: "shop", role: "backend", title: "API", description: "x" });
      assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
      w.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "api", detail: "npm test failed" }));
      const failed = await waitFor(() => sent.find((s) => s.n.title === "shop: task failed"));
      assert.deepEqual(failed.n, { title: "shop: task failed", body: "API\nnpm test failed", url: "/tasks/api", tag: "task-api" });
      w.ws.close();

      assert.deepEqual((await call(hub.port, "/api/push/subscriptions/delete", { endpoint: phone.sub.endpoint })).body, { removed: true, devices: 0 });
      assert.ok(existsSync(path.join(root, ".aso", "push.json")), "keys live with the Hub-wide state");
    } finally {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not replay old news after a restart", async () => {
    const root = tempDir("aso-root-");
    mkdirSync(root, { recursive: true });
    const repo = makeTargetRepo();
    git(root, "clone", "--quiet", repo, "shop");
    rmSync(repo, { recursive: true, force: true });
    const sent: PushNotification[] = [];
    const send = (async (_s: PushSubscriptionJson, n: PushNotification) => (sent.push(n), { ok: true })) as unknown as typeof sendPush;
    const start = () => startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false }, push: { send } });
    let hub = await start();
    try {
      await call(hub.port, "/api/push/subscriptions", browser().sub);
      await call(hub.port, "/api/tasks", { taskId: "api", project: "shop", role: "backend", title: "API", description: "x" });
      await call(hub.port, "/api/tasks/api/cancel", {});
      await hub.close();
      hub = await start();
      assert.equal((await call(hub.port, "/api/push")).body.devices, 1, "the device is still subscribed");
      await call(hub.port, "/api/tasks/api/retry", {});
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(sent, [], "nothing notable happened");
    } finally {
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
