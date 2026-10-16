import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMessage } from "@aso/shared";
import { TOKEN, waitFor, withHub, worker } from "./helpers.ts";

type ApiNode = { nodeId: string; hardware: { docker: { available: boolean; version?: string } } };
const nodes = async (port: number) =>
  (await (await fetch(`http://127.0.0.1:${port}/api/nodes`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as ApiNode[];
const heartbeat = (dockerAvailable: boolean) => ({ memoryAvailableBytes: 1, cpuLoadPercent: 1, dockerAvailable });

describe("heartbeats", () => {
  it("keep a worker's recorded Docker status in step with what it reports now", async () => {
    await withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev", { docker: false });
      const docker = async () => (await nodes(ctx.port)).find((n) => n.nodeId === "dev")?.hardware.docker;

      // The check at registration failed once; the next heartbeat finds Docker.
      w.send(createMessage("NODE_HEARTBEAT", "dev", heartbeat(true)));
      await waitFor(async () => (await docker())?.available === true, 5000, "docker available");
      assert.equal(ctx.hub.registry.setHeartbeat("dev", heartbeat(true)), undefined, "no change, nothing to log");

      assert.equal(ctx.hub.registry.setHeartbeat("dev", heartbeat(false)), false, "Docker stopped");
      assert.deepEqual(await docker(), { available: false });
      assert.equal(ctx.hub.registry.setHeartbeat("gone", heartbeat(true)), undefined, "unknown node");
      w.ws.close();
    });
  });

  it("keep the Docker version from registration while Docker stays up", async () => {
    await withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev", { docker: true });
      const before = (await nodes(ctx.port))[0].hardware.docker;
      assert.equal(ctx.hub.registry.setHeartbeat("dev", heartbeat(true)), undefined);
      assert.deepEqual((await nodes(ctx.port))[0].hardware.docker, before);
      w.ws.close();
    });
  });
});
