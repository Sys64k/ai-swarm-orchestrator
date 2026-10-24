import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { NodeOwners, nodeIdsInUse, startHub, type HubHandle } from "@aso/hub";
import { createMessage } from "@aso/shared";
import { connect, hardware, makeTargetRepo, postTask, tempDir, TOKEN, waitFor, worker } from "./helpers.ts";

const call = (port: number, route: string, body: unknown, auth: string | null = TOKEN) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<{ code?: string; key?: string }>);

/** Saving happens in the background: wait for the file to say `expected`. */
const savedAs = (file: string, expected: Record<string, string | null>) =>
  waitFor(() => {
    try {
      return JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) === JSON.stringify(expected) || undefined;
    } catch {
      return undefined;
    }
  });

describe("node owners", () => {
  it("saves who registered each node id, owner-only, and forgets what nothing needs", async () => {
    const dir = tempDir();
    const owners = await NodeOwners.open(dir);
    owners.record("avalon-1", "k1");
    owners.record("canfod-1", null);
    owners.record("avalon-2", "k1");
    const file = path.join(dir, "node-owners.json");
    await savedAs(file, { "avalon-1": "k1", "canfod-1": null, "avalon-2": "k1" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual([...owners.nodesOf("k1")], ["avalon-1", "avalon-2"]);

    const reopened = await NodeOwners.open(dir);
    assert.equal(reopened.ownerOf("canfod-1"), null, "the Hub's token is remembered as null");
    assert.equal(reopened.ownerOf("avalon-1"), "k1");
    assert.equal(reopened.ownerOf("never"), undefined);

    reopened.prune(new Set(["avalon-2"]));
    await savedAs(file, { "avalon-2": "k1" });
    assert.equal(reopened.ownerOf("avalon-1"), undefined);
  });

  it("knows which node ids tasks still name", () => {
    assert.deepEqual([...nodeIdsInUse([{ nodeId: "a" }, { qaNodeId: "b" }, { nodeId: "a", qaNodeId: "c" }, {}])], ["a", "b", "c"]);
  });

  it("starts empty from a damaged file instead of failing", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "node-owners.json"), "{not json");
    assert.equal((await NodeOwners.open(dir)).ownerOf("x"), undefined);
    writeFileSync(path.join(dir, "node-owners.json"), JSON.stringify({ x: 5 }));
    assert.equal((await NodeOwners.open(dir)).ownerOf("x"), undefined, "a wrong shape counts as damaged");
  });

  it("keeps a worker's held job with its credential across a Hub restart", async () => {
    const repoDir = makeTargetRepo();
    let hub: HubHandle | undefined;
    const start = async () => (hub = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", token: TOKEN }));
    try {
      let port = (await start()).port;
      const code = (await call(port, "/api/worker-keys/join-codes", {})).code!;
      const key = (await call(port, "/api/worker-keys/join", { code, machine: "avalon" }, null)).key!;

      const avalon = await worker(port, "avalon-1", { token: key, hostname: "avalon" });
      await postTask(port, { taskId: "held", role: "backend", title: "Held", description: "d" });
      assert.equal((await avalon.next()).type, "TASK_ASSIGNMENT");
      avalon.send(createMessage("STATUS_UPDATE", "avalon-1", { state: "in_progress", taskId: "held" }));
      await waitFor(() => hub!.tasks.get("held")?.state === "in_progress");
      // A node registered with the Hub's token that holds nothing.
      const idle = await worker(port, "idle-1");
      idle.ws.close();

      await hub!.close();
      port = (await start()).port;

      const thief = await connect(port, TOKEN);
      thief.send(createMessage("NODE_REGISTRATION", "avalon-1", { nodeKind: "worker", version: "test", hardware: hardware(), running: [{ taskId: "held", job: "implement" }] }));
      assert.equal(await thief.closed, 4403, "the held job's node id still belongs to avalon's key");

      const back = await worker(port, "avalon-1", { token: key, hostname: "avalon" });
      assert.ok(back, "avalon itself comes back to its job");

      const reuse = await connect(port, key);
      reuse.send(createMessage("NODE_REGISTRATION", "idle-1", { nodeKind: "worker", version: "test", hardware: hardware() }));
      assert.equal((await reuse.next()).type, "REGISTRATION_ACK", "a node id no task names was forgotten on start");
    } finally {
      await hub?.close();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
