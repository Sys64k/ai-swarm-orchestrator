import assert from "node:assert/strict";
import type os from "node:os";
import { describe, it } from "node:test";
import { lanConsoleUrl, tailscaleConsoleUrl } from "../dist/commands/console-link.js";

describe("console link address", () => {
  it("prefers the tailnet HTTPS address when tailscale serve proxies to the console", () => {
    const status = { Web: { "agent007.tailc9777f.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7421" } } } } };
    assert.equal(tailscaleConsoleUrl(status, 7421), "https://agent007.tailc9777f.ts.net");
    assert.equal(tailscaleConsoleUrl({ Web: { "a.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7421" } } } } }, 7421), "https://a.ts.net:8443");
    assert.equal(tailscaleConsoleUrl(status, 9999), undefined, "serving something else");
    assert.equal(tailscaleConsoleUrl({}, 7421), undefined, "not serving");
  });

  it("falls back to a private LAN address, never Docker or Tailscale interfaces", () => {
    const addr = (address: string, internal = false) => ({ address, family: "IPv4", internal }) as os.NetworkInterfaceInfo;
    const interfaces = {
      lo: [addr("127.0.0.1", true)],
      docker0: [addr("172.17.0.1")],
      "br-1a2b": [addr("172.18.0.1")],
      tailscale0: [addr("100.94.233.79")],
      wlx80afcad40793: [addr("192.168.101.127")],
    };
    assert.equal(lanConsoleUrl(interfaces, 7421), "http://192.168.101.127:7421");
    assert.equal(lanConsoleUrl({ lo: interfaces.lo, docker0: interfaces.docker0 }, 7421), undefined);
  });
});
