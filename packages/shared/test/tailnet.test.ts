import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTailnetAddress, NO_TAILNET, parseTailscaleStatus, replySource, tailnet } from "@aso/shared";

const status = {
  BackendState: "Running",
  Self: { HostName: "avalon", TailscaleIPs: ["100.98.58.22"], Online: true },
  Peer: {
    a: { HostName: "agent007", TailscaleIPs: ["100.94.233.79", "fd7a:115c:a1e0::4e35:e950"], Online: true },
    b: { HostName: "pixel-9a", TailscaleIPs: ["100.85.127.95"], Online: false },
    c: { HostName: "broken", Online: true },
  },
};

describe("this machine's tailnet", () => {
  it("lists the online peers' IPv4 addresses, not itself, offline ones or IPv6", () => {
    assert.deepEqual(parseTailscaleStatus(status), { running: true, peers: ["100.94.233.79"] });
  });

  it("isn't there unless Tailscale runs and is logged in", () => {
    assert.deepEqual(parseTailscaleStatus({ ...status, BackendState: "Stopped" }), NO_TAILNET);
    assert.deepEqual(parseTailscaleStatus({ BackendState: "NeedsLogin" }), NO_TAILNET);
    assert.deepEqual(parseTailscaleStatus(null), NO_TAILNET);
    assert.deepEqual(parseTailscaleStatus({ BackendState: "Running" }), { running: true, peers: [] }, "running, alone");
  });

  it("reads `tailscale status --json`, and copes when it's missing or odd", async () => {
    assert.deepEqual(await tailnet(async () => JSON.stringify(status)), { running: true, peers: ["100.94.233.79"] });
    assert.deepEqual(await tailnet(async () => undefined), NO_TAILNET, "no tailscale command");
    assert.deepEqual(await tailnet(async () => "not json"), NO_TAILNET);
  });

  it("knows Tailscale's addresses", () => {
    assert.equal(isTailnetAddress("100.94.233.79"), true);
    assert.equal(isTailnetAddress("100.64.0.1"), true);
    assert.equal(isTailnetAddress("100.128.0.1"), false);
    assert.equal(isTailnetAddress("192.168.101.112"), false);
  });

  it("tells which way an answer came, IPv4-mapped senders too", () => {
    assert.equal(replySource("100.94.233.79"), "tailnet");
    assert.equal(replySource("::ffff:100.94.233.79"), "tailnet");
    assert.equal(replySource("192.168.101.112"), "lan");
    assert.equal(replySource("::ffff:192.168.101.112"), "lan");
  });
});
