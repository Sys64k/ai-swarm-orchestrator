import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkTransport, machineName } from "../dist/join.js";
import { joinCommand, joinInstructions, keyLine } from "../dist/commands/worker-keys.js";

const resolving = (ips: string[]) => async () => ips;

describe("joining a Hub from anywhere", () => {
  it("refuses plain ws:// to a Hub on the internet, unless told otherwise", async () => {
    await assert.rejects(checkTransport("hub.example.com", 7420, false, resolving(["203.0.113.5"])), /on the internet, and ws:\/\/ would send the key and every job there unencrypted/);
    await checkTransport("hub.example.com", 7420, true, resolving(["203.0.113.5"]));
    await checkTransport("wss://hub.example.com", 443, false, resolving(["203.0.113.5"]));
    await checkTransport("agent007", 7420, false, resolving(["100.94.233.79"])); // Tailscale
    await checkTransport("192.168.1.10", 7420, false, resolving(["192.168.1.10"]));
    await assert.rejects(checkTransport("both", 7420, false, resolving(["192.168.1.10", "203.0.113.5"])), /203\.0\.113\.5/, "any public address counts");
    await assert.rejects(
      checkTransport("unknown-name", 7420, false, async () => {
        throw new Error("ENOTFOUND");
      }),
      /cannot resolve the Hub's address unknown-name/,
      "unknown is not private",
    );
    assert.equal(machineName("my laptop\nfake log line"), "my-laptop-fake-log-line");
    assert.equal(machineName("ä"), "machine");
  });

  it("tells the new machine what to run, and lists keys plainly", () => {
    const lines = joinInstructions("agent007", "CODE123", "2026-10-24T15:00:00.000Z", "ab12");
    // The same line as the console's joinCommand (packages/dashboard/test/view.test.ts asserts this string too).
    assert.equal(joinCommand("agent007", "CODE123", "ab12"), 'd=$(mktemp -d) && curl -fo "$d/aso.tgz" http://agent007:7420/dist/aso.tgz && echo "ab12  $d/aso.tgz" | sha256sum -c - && npm install -g "$d/aso.tgz" && aso service install --join CODE123');
    assert.ok(lines.includes(`  ${joinCommand("agent007", "CODE123", "ab12")}`), "one line, without --hub: the worker finds the Hub on the LAN or over Tailscale");
    assert.equal(
      joinCommand("wss://agent007.tailc9777f.ts.net:10000", "C0DE"),
      'd=$(mktemp -d) && curl -fo "$d/aso.tgz" https://agent007.tailc9777f.ts.net:10000/dist/aso.tgz && npm install -g "$d/aso.tgz" && aso service install --hub wss://agent007.tailc9777f.ts.net:10000 --join C0DE',
      "through the worker gateway: over TLS, and the worker keeps the address (no discovery on the internet)",
    );
    assert.ok(lines.some((l) => l.includes("add\n") || l.includes("--hub agent007")), "what to add when it can't");
    assert.equal(keyLine({ id: "k1", name: "avalon", createdAt: "x", connected: true }), "k1  avalon  (connected)");
    assert.equal(keyLine({ id: "k2", name: "mbp", createdAt: "x", connected: false }), "k2  mbp  (never used)");
    assert.equal(keyLine({ id: "k3", name: "old", createdAt: "x", connected: false, revokedAt: "2026-10-24T10:00:00Z" }), "k3  old  (revoked 2026-10-24T10:00:00Z)");
  });
});
