import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import { describe, it } from "node:test";
import {
  acceptDiscoveryReply,
  broadcastAddresses,
  discoverHub,
  discoveryKeyId,
  discoveryProof,
  discoverySecret,
  localAddresses,
  newDiscoveryQuery,
  parseDiscoveryQuery,
  parseDiscoveryReply,
  type DiscoveryReply,
} from "@aso/shared";

const KEY = "asow_the-workers-own-key";
const NONCE = "AAAAAAAAAAAAAAAAAAAAAA";

/** The answer a Hub holding `credential` gives from `addresses`. */
function answer(credential: string, nonce = NONCE, addresses = ["192.168.101.112"], port = 7420): DiscoveryReply {
  const claim = { nonce, port, addresses };
  return { aso: "hub", v: 1, ...claim, proof: discoveryProof(discoverySecret(credential), claim) };
}

const iface = (address: string, netmask: string, internal = false, family: "IPv4" | "IPv6" = "IPv4") =>
  ({ address, netmask, family, internal, mac: "00:00:00:00:00:00", cidr: null }) as never;

describe("LAN discovery", () => {
  it("names a credential by a hash of its secret, and the secret is what the Hub stores of a key", () => {
    const secret = discoverySecret(KEY);
    assert.equal(secret, createHash("sha256").update(KEY).digest("hex"), "the Hub keeps exactly this hash of a worker key");
    const query = newDiscoveryQuery(KEY, NONCE);
    assert.equal(query.key, discoveryKeyId(secret));
    assert.ok(!query.key.includes(secret.slice(0, 16)), "the id is not part of the secret");
    assert.deepEqual(parseDiscoveryQuery(Buffer.from(JSON.stringify(query))), query);
  });

  it("trusts only a proven answer from an address the Hub lists", () => {
    const expect = { nonce: NONCE, credential: KEY, from: "192.168.101.112" };
    assert.equal(acceptDiscoveryReply(answer(KEY), expect), "192.168.101.112:7420");
    assert.equal(acceptDiscoveryReply(answer(KEY), { ...expect, from: "::ffff:192.168.101.112" }), "192.168.101.112:7420", "IPv4-mapped sender");

    assert.equal(acceptDiscoveryReply(answer("asow_someone-elses"), expect), undefined, "a Hub without our key");
    assert.equal(acceptDiscoveryReply(answer(KEY, "BBBBBBBBBBBBBBBBBBBBBB"), expect), undefined, "an answer to another query");
    assert.equal(acceptDiscoveryReply(answer(KEY), { ...expect, from: "192.168.101.66" }), undefined, "a copied answer sent from another machine");
    const relisted = { ...answer(KEY), addresses: ["192.168.101.66"] };
    assert.equal(acceptDiscoveryReply(relisted, { ...expect, from: "192.168.101.66" }), undefined, "the proof covers the addresses");
    assert.equal(acceptDiscoveryReply({ ...answer(KEY), port: 9999 }, expect), undefined, "the proof covers the port");
    const publicHub = answer(KEY, NONCE, ["203.0.113.5"]);
    assert.equal(acceptDiscoveryReply(publicHub, { ...expect, from: "203.0.113.5" }), undefined, "only private addresses: discovery is for the LAN");
  });

  it("ignores packets that aren't well-formed queries or answers", () => {
    assert.equal(parseDiscoveryQuery(Buffer.from("not json")), undefined);
    assert.equal(parseDiscoveryQuery(Buffer.from(JSON.stringify({ ...newDiscoveryQuery(KEY, NONCE), extra: 1 }))), undefined);
    assert.equal(parseDiscoveryQuery(Buffer.from(JSON.stringify({ ...newDiscoveryQuery(KEY, NONCE), v: 2 }))), undefined, "another version");
    assert.equal(parseDiscoveryReply(Buffer.from(JSON.stringify({ ...answer(KEY), proof: "zz" }))), undefined);
    assert.equal(parseDiscoveryReply(Buffer.from(JSON.stringify({ ...answer(KEY), addresses: [] }))), undefined);
    assert.equal(parseDiscoveryReply(Buffer.alloc(4096, 32)), undefined, "oversized");
    assert.deepEqual(parseDiscoveryReply(Buffer.from(JSON.stringify(answer(KEY)))), answer(KEY));
  });

  it("broadcasts on every IPv4 network and lists only LAN addresses", () => {
    const interfaces = {
      lo: [iface("127.0.0.1", "255.0.0.0", true)],
      wlan0: [iface("192.168.101.112", "255.255.255.0"), iface("fe80::1", "ffff:ffff:ffff:ffff::", false, "IPv6")],
      tailscale0: [iface("100.94.233.79", "255.255.255.255")],
      docker0: [iface("172.17.0.1", "255.255.0.0")],
    };
    assert.deepEqual(broadcastAddresses(interfaces), ["255.255.255.255", "192.168.101.255", "100.94.233.79", "172.17.255.255"]);
    assert.deepEqual(localAddresses(interfaces), ["192.168.101.112", "100.94.233.79", "172.17.0.1"]);
    assert.deepEqual(broadcastAddresses({}), ["255.255.255.255"]);
  });

  /** A UDP responder on loopback that answers each query with `reply(query)`. */
  async function fakeHub(reply: (query: { nonce: string }) => DiscoveryReply | undefined) {
    const socket = dgram.createSocket("udp4");
    socket.on("message", (msg, rinfo) => {
      const query = parseDiscoveryQuery(msg);
      const answerTo = query && reply(query);
      if (answerTo) socket.send(JSON.stringify(answerTo), rinfo.port, rinfo.address);
    });
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    return { port: socket.address().port, close: () => socket.close() };
  }

  it("finds the Hub that proves it holds our credential", async () => {
    const hub = await fakeHub((q) => answer(KEY, q.nonce, ["127.0.0.1"]));
    try {
      assert.equal(await discoverHub(KEY, { port: hub.port, targets: ["127.0.0.1"], timeoutMs: 1000 }), "127.0.0.1:7420");
    } finally {
      hub.close();
    }
  });

  it("finds nothing when only impostors or nobody answer", async () => {
    const impostor = await fakeHub((q) => answer("asow_a-guess", q.nonce, ["127.0.0.1"]));
    try {
      assert.equal(await discoverHub(KEY, { port: impostor.port, targets: ["127.0.0.1"], timeoutMs: 300 }), undefined);
    } finally {
      impostor.close();
    }
    const silent = await fakeHub(() => undefined);
    try {
      assert.equal(await discoverHub(KEY, { port: silent.port, targets: ["127.0.0.1"], timeoutMs: 300 }), undefined);
    } finally {
      silent.close();
    }
  });
});
