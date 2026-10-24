import assert from "node:assert/strict";
import dgram from "node:dgram";
import { describe, it } from "node:test";
import { discoverHub, discoveryProof, discoverySecret, newDiscoveryQuery, parseDiscoveryReply } from "@aso/shared";
import { answerQuery, MAX_ANSWERS_PER_WINDOW, startDiscoveryResponder, type ResponderOptions } from "../dist/discovery-responder.js";
import { findHub } from "../dist/join.js";
import { workerArgs } from "../dist/service.js";

process.env.ASO_LOG_LEVEL ??= "error";

const KEY = "asow_the-workers-own-key";
/** A Hub that holds only KEY. */
const prove: ResponderOptions["prove"] = async (query, claim) => {
  const secret = discoverySecret(KEY);
  return query.key === newDiscoveryQuery(KEY).key ? discoveryProof(secret, { nonce: query.nonce, ...claim }) : undefined;
};
const loopback = () => ["127.0.0.1"];

async function withResponder(opts: Partial<ResponderOptions>, run: (port: number) => Promise<void>) {
  const responder = startDiscoveryResponder({ port: 0, hubPort: 7420, prove, addresses: loopback, ...opts });
  try {
    const port = await responder.listening;
    assert.ok(port);
    await run(port);
  } finally {
    await responder.close();
  }
}

describe("answering LAN discovery on the Hub's machine", () => {
  it("tells a worker holding a key the Hub knows where the Hub is", () =>
    withResponder({}, async (port) => {
      assert.equal(await discoverHub(KEY, { port, targets: ["127.0.0.1"], timeoutMs: 1000 }), "127.0.0.1:7420");
    }));

  it("stays silent for a credential the Hub doesn't know, and without a LAN address", async () => {
    await withResponder({}, async (port) => {
      assert.equal(await discoverHub("asow_unknown", { port, targets: ["127.0.0.1"], timeoutMs: 300 }), undefined);
    });
    assert.equal(await answerQuery(newDiscoveryQuery(KEY), { hubPort: 7420, prove, addresses: () => [] }), undefined);
  });

  it("keeps answering after the Hub fails to prove one query", async () => {
    let calls = 0;
    const flaky: ResponderOptions["prove"] = (query, claim) => (++calls === 1 ? Promise.reject(new Error("Hub restarting")) : prove(query, claim));
    await withResponder({ prove: flaky }, async (port) => {
      assert.equal(await discoverHub(KEY, { port, targets: ["127.0.0.1"], timeoutMs: 1000 }), "127.0.0.1:7420", "the query's repeat gets through");
    });
  });

  it("answers a flood only up to its limit", () =>
    withResponder({}, async (port) => {
      const socket = dgram.createSocket("udp4");
      let answers = 0;
      socket.on("message", (msg) => parseDiscoveryReply(msg) && answers++);
      await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
      for (let i = 0; i < MAX_ANSWERS_PER_WINDOW + 10; i++) socket.send(JSON.stringify(newDiscoveryQuery(KEY)), port, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 500));
      socket.close();
      assert.equal(answers, MAX_ANSWERS_PER_WINDOW);
    }));

  it("runs on without discovery when its port is taken", async () => {
    const holder = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => holder.bind(0, resolve));
    const responder = startDiscoveryResponder({ port: holder.address().port, hubPort: 7420, prove });
    try {
      assert.equal(await responder.listening, undefined);
    } finally {
      await responder.close();
      holder.close();
    }
  });
});

describe("a worker without the Hub's address", () => {
  it("says what to check when no Hub answers", async () => {
    await assert.rejects(findHub(KEY, async () => undefined), /no Hub answered on this network \(UDP 7419\).*--hub <address>/s);
    assert.equal(await findHub(KEY, async () => "192.168.101.112:7420"), "192.168.101.112:7420");
  });

  it("installs a service that finds the Hub itself", () => {
    assert.deepEqual(workerArgs({ sandbox: "docker" }, 7420), ["start-worker"]);
    assert.deepEqual(workerArgs({ slots: 2 }, 7420), ["start-worker", "--slots", "2"]);
  });
});
