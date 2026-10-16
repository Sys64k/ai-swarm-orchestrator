import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { errorLine, installHubPackage } from "../dist/commands/update.js";

process.env.ASO_LOG_LEVEL ??= "error";

const dir = mkdtempSync(path.join(os.tmpdir(), "aso-update-test-"));
// npm installs "globally" into this prefix, never into the machine's own.
const prefix = path.join(dir, "prefix");
const savedPrefix = process.env.npm_config_prefix;
process.env.npm_config_prefix = prefix;

/** What the fake Hub serves: its version answer and the package bytes. */
let served: { version: string | null; package: boolean; sha256: string | null; tgz: Buffer };
let server: Server;
let base: string;

before(async () => {
  const src = path.join(dir, "src");
  mkdirSync(src);
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "aso-update-fixture", version: "1.0.0" }));
  const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir, src], { encoding: "utf8" }).trim().split("\n").pop()!;
  const tgz = readFileSync(path.join(dir, name));
  served = { version: "0.1.0+new", package: true, sha256: createHash("sha256").update(tgz).digest("hex"), tgz };
  server = createServer((req, res) => {
    if (req.url === "/api/version") return res.end(JSON.stringify({ version: served.version, package: served.package, sha256: served.sha256 }));
    if (req.url === "/dist/aso.tgz") return res.end(served.tgz);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  if (savedPrefix === undefined) delete process.env.npm_config_prefix;
  else process.env.npm_config_prefix = savedPrefix;
  rmSync(dir, { recursive: true, force: true });
});

const installed = () => existsSync(path.join(prefix, "lib", "node_modules", "aso-update-fixture", "package.json"));

describe("installing the Hub's package", () => {
  it("refuses a package that does not match the Hub's checksum", async () => {
    const good = served.sha256;
    served.sha256 = "0".repeat(64);
    try {
      await assert.rejects(installHubPackage(base, "0.1.0+old"), /does not match the Hub's checksum/);
      assert.ok(!installed());
    } finally {
      served.sha256 = good;
    }
  });

  it("refuses when the Hub serves no package, or cannot be reached", async () => {
    const saved = { ...served };
    Object.assign(served, { package: false, sha256: null, version: null });
    try {
      await assert.rejects(installHubPackage(base, "0.1.0+old"), /no aso package to serve/);
    } finally {
      Object.assign(served, saved);
    }
    await assert.rejects(installHubPackage("http://127.0.0.1:1", "0.1.0+old"), /cannot reach the Hub/);
  });

  it("installs nothing when this build is already the Hub's", async () => {
    assert.equal(await installHubPackage(base, "0.1.0+new"), false);
    assert.ok(!installed());
  });

  it("says what npm reported when the install fails", async () => {
    const good = { ...served };
    const tgz = Buffer.from("not a tarball");
    Object.assign(served, { version: "0.1.0+broken", tgz, sha256: createHash("sha256").update(tgz).digest("hex") });
    try {
      await assert.rejects(installHubPackage(base, "0.1.0+old"), /^Error: npm install exited with code 1: TAR_BAD_ARCHIVE: Unrecognized archive format$/);
      assert.ok(!installed());
    } finally {
      Object.assign(served, good);
    }
    assert.equal(errorLine("npm error code E404\nnpm error 404 Not Found - GET https://x\nnpm error A complete log of this run can be found in: /x.log\n"), "404 Not Found - GET https://x");
    assert.equal(errorLine("fatal: not a git repository\n"), "fatal: not a git repository", "not npm: the last line");
    assert.equal(errorLine(""), undefined);
  });

  it("downloads, verifies and installs the Hub's package", async () => {
    assert.equal(await installHubPackage(base, "0.1.0+old"), true);
    assert.ok(installed());
  });
});
