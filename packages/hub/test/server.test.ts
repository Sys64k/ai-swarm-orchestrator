import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createMessage } from "@aso/shared";
import { startHub, type HubHandle } from "@aso/hub";
import { connect as connectTo } from "./helpers.ts";

const PORT = 17_900 + Math.floor(Math.random() * 90);
let hub: HubHandle;

before(async () => {
  hub = await startHub({ targetDir: "/tmp/target", port: PORT, host: "127.0.0.1" });
});
after(() => hub.close());

const connect = () => connectTo(PORT);

const registration = (nodeId: string) =>
  createMessage("NODE_REGISTRATION", nodeId, { nodeKind: "architect", version: "test" });

describe("hub WebSocket protocol", () => {
  it("rejects malformed and invalid frames with PROTOCOL_ERROR", async () => {
    const c = await connect();
    c.send("not json");
    let m = await c.next();
    assert.equal(m.type, "PROTOCOL_ERROR");
    c.send({ type: "STATUS_UPDATE", id: "x" });
    m = await c.next();
    assert.ok(m.type === "PROTOCOL_ERROR" && m.payload.reason === "schema validation failed");
    assert.ok(m.type === "PROTOCOL_ERROR" && m.payload.refId === "x");
    c.ws.close();
  });

  it("requires registration before other messages", async () => {
    const c = await connect();
    c.send(createMessage("STATUS_UPDATE", "n1", { state: "idle" }));
    const m = await c.next();
    assert.ok(m.type === "PROTOCOL_ERROR" && /registration required/i.test(m.payload.reason));
    c.ws.close();
  });

  it("acks registration, lists the node and enforces envelope identity", async () => {
    const c = await connect();
    c.send(registration("arch-1"));
    const ack = await c.next();
    assert.ok(ack.type === "REGISTRATION_ACK" && ack.payload.nodeId === "arch-1");
    assert.equal(ack.from, "hub");

    const nodes = (await (await fetch(`http://127.0.0.1:${PORT}/api/nodes`)).json()) as Array<{ nodeId: string }>;
    assert.ok(nodes.some((n) => n.nodeId === "arch-1"));

    c.send(createMessage("STATUS_UPDATE", "someone-else", { state: "idle" }));
    const spoof = await c.next();
    assert.ok(spoof.type === "PROTOCOL_ERROR" && /does not match/.test(spoof.payload.reason));

    c.send(registration("arch-1"));
    const again = await c.next();
    assert.ok(again.type === "PROTOCOL_ERROR" && again.payload.reason === "already registered");
    c.ws.close();
  });

  it("rejects hub-only message types from nodes", async () => {
    const c = await connect();
    c.send(registration("arch-2"));
    await c.next();
    c.send(
      createMessage("TASK_ASSIGNMENT", "arch-2", {
        taskId: "t1",
        role: "backend",
        title: "x",
        description: "y",
      }),
    );
    const m = await c.next();
    assert.ok(m.type === "PROTOCOL_ERROR" && /may not send TASK_ASSIGNMENT/.test(m.payload.reason));
    c.ws.close();
  });

  it("rejects duplicate node ids and closes the second connection", async () => {
    const a = await connect();
    a.send(registration("dup"));
    await a.next();
    const b = await connect();
    b.send(registration("dup"));
    const m = await b.next();
    assert.ok(m.type === "PROTOCOL_ERROR" && /already in use/.test(m.payload.reason));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(b.closeCode(), 4009);
    a.ws.close();
  });
});
