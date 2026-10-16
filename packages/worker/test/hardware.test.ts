import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { distroName, dockerFailure, dockerServerVersion, osReleaseName, probeDocker, profileHardware } from "@aso/worker";

const dir = mkdtempSync(path.join(os.tmpdir(), "aso-docker-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in `docker` CLI that prints `out` and exits with `code`. */
function fakeDocker(name: string, out: string, code: number, err = ""): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\necho '${out}'\n${err ? `echo '${err}' >&2\n` : ""}exit ${code}\n`);
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

  it("says why Docker did not answer", async () => {
    const daemonDown = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
    assert.deepEqual(await probeDocker(fakeDocker("down-msg", "", 1, daemonDown)), { error: daemonDown });
    assert.deepEqual(await probeDocker(fakeDocker("empty-msg", "", 0)), { error: "`docker version` printed no server version" });
    assert.deepEqual(await probeDocker(path.join(dir, "missing")), { error: "the docker CLI is not on PATH" });
    assert.deepEqual(await probeDocker(fakeDocker("ok-msg", "29.2.0", 0)), { version: "29.2.0" });
  });

  it("describes a hung or silent docker CLI", () => {
    const err = (fields: Partial<Parameters<typeof dockerFailure>[0]>) => Object.assign(new Error("Command failed: docker version\nmore"), fields);
    assert.equal(dockerFailure(err({ killed: true, signal: "SIGTERM" })), "`docker version` did not answer within 10 s");
    assert.equal(dockerFailure(err({ stderr: "\n  \n" })), "Command failed: docker version", "no stderr: the first line of the error");
    assert.equal(dockerFailure(err({ stderr: "\npermission denied while trying to connect\nsecond line" })), "permission denied while trying to connect");
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

describe("hardware profile", () => {
  it("names the OS from os-release", async () => {
    assert.equal(osReleaseName('NAME="Ubuntu"\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04.1 LTS"\n'), "Ubuntu 26.04.1 LTS");
    assert.equal(osReleaseName("NAME='Pop!_OS'\nVERSION_ID=24.04\n"), "Pop!_OS 24.04", "no PRETTY_NAME");
    assert.equal(osReleaseName("# comment\nID=alpine\n"), "");

    const file = path.join(dir, "os-release");
    writeFileSync(file, 'PRETTY_NAME="Linux Mint 22.2"\n');
    assert.equal(await distroName([path.join(dir, "absent"), file]), "Linux Mint 22.2", "the first file that exists");
    assert.equal(await distroName([path.join(dir, "absent")]), `${os.type()} ${os.release()}`, "no os-release");
    writeFileSync(file, "ID=x\n");
    assert.equal(await distroName([file]), `${os.type()} ${os.release()}`, "os-release without a name");
  });

  it("does not wait on a slow `hostname -f`, and still finds Docker", async () => {
    // avalon's own name took 130 s to resolve; the scan used to run `hostname -f` synchronously,
    // which also made the Docker probe beside it time out.
    const bin = path.join(dir, "slow-bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "hostname"), "#!/bin/sh\nsleep 20\n");
    chmodSync(path.join(bin, "hostname"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const started = Date.now();
      const profile = await profileHardware(path.join(dir, "work"));
      assert.ok(Date.now() - started < 10_000, `scan took ${Date.now() - started} ms`);
      assert.equal(profile.docker.version, await dockerServerVersion());
      assert.equal(profile.platform, os.platform());
      assert.ok(profile.distro);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
