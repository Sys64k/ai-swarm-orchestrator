import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { dockerServerVersion } from "@aso/worker";

const dir = mkdtempSync(path.join(os.tmpdir(), "aso-docker-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in `docker` CLI that prints `out` and exits with `code`. */
function fakeDocker(name: string, out: string, code: number): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho '${out}'\nexit ${code}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("Docker detection", () => {
  it("reports the server version the docker CLI gets, whatever socket its context uses", async () => {
    assert.equal(await dockerServerVersion(fakeDocker("ok", "29.2.0", 0)), "29.2.0");
  });

  it("reports no Docker when the daemon does not answer or the CLI is missing", async () => {
    // `docker version` prints the client part and exits 1 when it cannot reach a daemon.
    assert.equal(await dockerServerVersion(fakeDocker("down", "", 1)), undefined);
    assert.equal(await dockerServerVersion(fakeDocker("empty", "", 0)), undefined);
    assert.equal(await dockerServerVersion(path.join(dir, "missing")), undefined);
  });

  it("agrees with the real docker CLI on this machine", async () => {
    let expected: string | undefined;
    try {
      expected = execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" }).trim() || undefined;
    } catch {
      expected = undefined;
    }
    assert.equal(await dockerServerVersion(), expected);
  });
});
