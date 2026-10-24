import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { WorkerKeys } from "@aso/hub";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMessage } from "@aso/shared";
import { connect, hardware, postTask, tempDir, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

/** Clone with nothing but `key` (the test helpers' git adds the Hub's token). Async: the Hub runs in this process. */
const cloneInto = (port: number, key: string, dir: string) =>
  promisify(execFile)("git", ["clone", "--quiet", `http://x-access-token:${key}@127.0.0.1:${port}/git/project.git`, "."], {
    cwd: dir,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
const cloneWith = (port: number, key: string) => cloneInto(port, key, tempDir());

const call = (port: number, route: string, init: { method?: string; auth?: string | null; body?: unknown } = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: init.method ?? "GET",
    headers: { ...(init.auth === null ? {} : { authorization: `Bearer ${init.auth ?? TOKEN}` }), "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as any }));

/** Create a join code with the Hub's token and join with it, as a new machine would. */
async function joinAs(port: number, machine: string, name?: string) {
  const code = (await call(port, "/api/worker-keys/join-codes", { method: "POST", body: name ? { name } : {} })).body.code as string;
  const joined = await call(port, "/api/worker-keys/join", { method: "POST", auth: null, body: { code, machine } });
  return { code, ...joined };
}

describe("worker keys", () => {
  it("ignores a damaged entry instead of failing every request", async () => {
    const dir = tempDir();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "worker-keys.json"), JSON.stringify([{ id: "x", name: "x", hash: "abc", createdAt: "2026-10-24T10:00:00Z" }]));
    const keys = await WorkerKeys.open(dir);
    assert.equal(keys.verify("asow_anything"), undefined);
  });

  it("trades a one-time join code for a key, once, keeping only its hash", async () => {
    const dir = tempDir();
    const keys = await WorkerKeys.open(dir);
    const { code } = keys.createJoinCode();
    const joined = await keys.join(code, "avalon");
    assert.ok(joined);
    assert.match(joined.key, /^asow_[A-Za-z0-9_-]{40,}$/);
    assert.equal(joined.name, "avalon");
    assert.equal(await keys.join(code, "avalon"), undefined, "a code works once");
    assert.deepEqual(keys.verify(joined.key)?.id, joined.id);
    assert.equal(keys.verify(`${joined.key}x`), undefined);
    assert.equal(keys.verify(TOKEN), undefined, "the Hub's token is not a worker key");

    const saved = readFileSync(path.join(dir, "worker-keys.json"), "utf8");
    assert.doesNotMatch(saved, new RegExp(joined.key), "only the hash is stored");
    assert.equal(statSync(path.join(dir, "worker-keys.json")).mode & 0o777, 0o600);
    const reopened = await WorkerKeys.open(dir);
    assert.equal(reopened.verify(joined.key)?.name, "avalon", "survives a restart");
    await reopened.revoke(joined.id);
    assert.equal(reopened.verify(joined.key), undefined);
  });

  it("refuses an expired code, and names the key as asked", async () => {
    const keys = await WorkerKeys.open();
    const old = keys.createJoinCode(undefined, Date.now() - 31 * 60_000);
    assert.equal(await keys.join(old.code, "avalon"), undefined);
    const named = keys.createJoinCode("laptop in Lisbon");
    assert.equal((await keys.join(named.code, "mbp"))?.name, "laptop in Lisbon");
  });

  it("lets a machine with a key do worker work only, and shuts it out when revoked", () =>
    withHub(async (ctx) => {
      assert.equal((await call(ctx.port, "/api/worker-keys/join-codes", { method: "POST", auth: null })).status, 401, "join codes need the Hub's token");
      const joined = await joinAs(ctx.port, "avalon");
      assert.equal(joined.status, 201);
      const key = joined.body.key as string;
      assert.equal((await call(ctx.port, "/api/worker-keys/join", { method: "POST", auth: null, body: { code: joined.code, machine: "x" } })).status, 403, "used up");

      // Worker work: the connection and Git.
      const ws = await worker(ctx.port, "avalon-1", { token: key, hostname: "avalon" });
      const node = await waitFor(async () => (await call(ctx.port, "/api/nodes")).body.find((n: any) => n.nodeId === "avalon-1"));
      assert.deepEqual(node.workerKey, { id: joined.body.id, name: "avalon" });
      await cloneWith(ctx.port, key);
      await assert.rejects(cloneWith(ctx.port, "asow_not-a-key"), "a made-up key gets nowhere");

      // Nothing else: no plans, no merges, no deploys, no keys.
      for (const [route, method] of [["/api/tasks", "GET"], ["/api/plans", "POST"], ["/api/worker-keys", "GET"], ["/api/projects/project/deploy", "POST"]] as const) {
        assert.equal((await call(ctx.port, route, { method, auth: key, body: method === "POST" ? {} : undefined })).status, 401, `${method} ${route}`);
      }

      const listed = (await call(ctx.port, "/api/worker-keys")).body;
      assert.deepEqual(listed.map((k: any) => [k.name, k.connected]), [["avalon", true]]);
      assert.equal(listed[0].key, undefined);
      assert.equal(listed[0].hash, undefined);

      const revoked = await call(ctx.port, `/api/worker-keys/${joined.body.id}/revoke`, { method: "POST" });
      assert.equal(revoked.status, 200);
      assert.equal(await ws.closed, 4401, "disconnected at once");
      assert.equal((await call(ctx.port, `/api/worker-keys/nope/revoke`, { method: "POST" })).status, 404);
      await assert.rejects(connect(ctx.port, key).then((c) => c.closed), "can't come back");
      await assert.rejects(cloneWith(ctx.port, key), "nor Git");
    }));

  it("lets a key register one worker, never the Architect, and never a node another credential registered", () =>
    withHub(async (ctx) => {
      const { key } = (await joinAs(ctx.port, "avalon")).body as { key: string };
      const architect = await connect(ctx.port, key);
      architect.send(createMessage("NODE_REGISTRATION", "architect-evil", { nodeKind: "architect", version: "test" } as never));
      assert.equal(await architect.closed, 4403, "a key can't be the Architect");

      const first = await worker(ctx.port, "avalon-1", { token: key, hostname: "avalon" });
      const second = await worker(ctx.port, "avalon-2", { token: key, hostname: "avalon" });
      assert.equal(await first.closed, 4409, "one worker per key: the newer connection replaces the older");
      const nodes = (await call(ctx.port, "/api/nodes")).body.map((n: any) => n.nodeId);
      assert.ok(nodes.includes("avalon-2") && !nodes.includes("avalon-1"));

      // A node id the Hub's token registered can't be taken over with a key, even once it's gone.
      const canfod = await worker(ctx.port, "canfod-1");
      canfod.ws.close();
      await waitFor(async () => !(await call(ctx.port, "/api/nodes")).body.some((n: any) => n.nodeId === "canfod-1"));
      second.ws.close();
      await second.closed;
      const thief = await connect(ctx.port, key);
      thief.send(createMessage("NODE_REGISTRATION", "canfod-1", { nodeKind: "worker", version: "test", hardware: hardware() }));
      assert.equal(await thief.closed, 4403);
    }));

  it("lets a key push only to the task its own worker implements", () =>
    withHub(async (ctx) => {
      const { key } = (await joinAs(ctx.port, "avalon")).body as { key: string };
      const w = await worker(ctx.port, "avalon-1", { token: key, hostname: "avalon" });
      await postTask(ctx.port, { taskId: "mine", role: "backend", title: "Mine", description: "d" });
      assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
      w.send(createMessage("STATUS_UPDATE", "avalon-1", { state: "in_progress", taskId: "mine" }));
      await waitFor(() => ctx.hub.tasks.get("mine")?.state === "in_progress");
      await postTask(ctx.port, { taskId: "theirs", role: "backend", title: "Theirs", description: "d" });

      const dir = tempDir();
      await cloneInto(ctx.port, key, dir);
      const push = (branch: string) =>
        promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", branch], { cwd: dir }).then(() =>
          promisify(execFile)("git", ["push", "--quiet", "origin", `HEAD:refs/heads/task/${branch}`], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }),
        );
      await push("mine");
      await assert.rejects(push("theirs"), /403/, "not its task");
    }));

  it("drops a revoked key's worker at once", () =>
    withHub(async (ctx) => {
      const joined = (await joinAs(ctx.port, "avalon")).body as { id: string; key: string };
      await worker(ctx.port, "avalon-1", { token: joined.key, hostname: "avalon" });
      await call(ctx.port, `/api/worker-keys/${joined.id}/revoke`, { method: "POST" });
      assert.equal((await call(ctx.port, "/api/nodes")).body.some((n: any) => n.nodeId === "avalon-1"), false, "gone without waiting for a close handshake");
    }));

  it("slows down a flood of wrong join codes", () =>
    withHub(async (ctx) => {
      let status = 0;
      for (let i = 0; i < 35 && status !== 429; i++) status = (await call(ctx.port, "/api/worker-keys/join", { method: "POST", auth: null, body: { code: `guess-${i}`, machine: "m" } })).status;
      assert.equal(status, 429);
      const fresh = await joinAs(ctx.port, "avalon");
      assert.equal(fresh.status, 201, "a real code still joins: a flood can't keep machines out");
      const again = await call(ctx.port, "/api/worker-keys/join", { method: "POST", auth: null, body: { code: "guess-again", machine: "m" } });
      assert.equal(again.status, 429, "wrong codes stay slowed down");
    }));
});
