import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { credentialOf, isAuthorized, isPrivateAddress, resolveWorkerToken, saveWorkerKey } from "@aso/shared";

describe("credentials and private networks", () => {
  it("reads the secret from Bearer and Basic headers", () => {
    assert.equal(credentialOf("Bearer asow_abc"), "asow_abc");
    assert.equal(credentialOf(`Basic ${Buffer.from("x-access-token:asow_abc").toString("base64")}`), "asow_abc");
    assert.equal(credentialOf("Digest x"), undefined);
    assert.equal(credentialOf(undefined), undefined);
    assert.equal(isAuthorized("Bearer aso_t", "aso_t"), true);
    assert.equal(isAuthorized("Bearer aso_x", "aso_t"), false);
  });

  it("knows which addresses stay private without TLS", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.1.1", "100.64.0.1", "100.94.233.79", "100.127.255.255", "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:192.168.1.10"]) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "2a00:1450:4001::1", "::ffff:8.8.8.8"]) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });

  it("saves the worker key owner-only and prefers it over an old ASO_TOKEN", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "aso-key-"));
    const saved = { config: process.env.ASO_CONFIG_DIR, token: process.env.ASO_TOKEN };
    process.env.ASO_CONFIG_DIR = dir;
    process.env.ASO_TOKEN = "aso_main-token";
    try {
      assert.equal(resolveWorkerToken()?.source, "ASO_TOKEN", "no key yet");
      const first = saveWorkerKey("asow_one");
      assert.equal(first.replaced, false);
      assert.equal(statSync(first.file).mode & 0o777, 0o600);
      assert.deepEqual(resolveWorkerToken(), { token: "asow_one", source: first.file });
      assert.equal(saveWorkerKey("asow_two").replaced, true);
      assert.equal(resolveWorkerToken()?.token, "asow_two");
    } finally {
      process.env.ASO_CONFIG_DIR = saved.config;
      if (saved.token === undefined) delete process.env.ASO_TOKEN;
      else process.env.ASO_TOKEN = saved.token;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
