import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { defaultSandboxImage, DockerSandbox, dockerRunArgs } from "@aso/worker";

process.env.ASO_LOG_LEVEL ??= "error";

describe("sandbox policy (docker run arguments)", () => {
  const args = dockerRunArgs({
    name: "aso-job-x",
    label: "aso.sandbox=abc",
    image: "img",
    user: "1000:1000",
    network: "bridge",
    checkout: "/w/project",
    cwd: "/w/project",
    cacheDir: "/w/cache",
    env: { CI: "1", EXTRA: "yes" },
    argv: ["npm", "test"],
  });
  const has = (...seq: string[]) => args.some((_, i) => seq.every((s, j) => args[i + j] === s));

  it("drops privileges and makes the root filesystem read-only", () => {
    assert.ok(has("--user", "1000:1000"));
    assert.ok(has("--cap-drop", "ALL"));
    assert.ok(has("--security-opt", "no-new-privileges"));
    assert.ok(args.includes("--read-only"));
    assert.ok(has("--pids-limit", "4096"));
    assert.ok(args.includes("--rm"));
  });

  it("mounts only the checkout (with .git read-only) and the cache", () => {
    const volumes = args.flatMap((a, i) => (a === "--volume" ? [args[i + 1]] : []));
    assert.deepEqual(volumes, ["/w/project:/w/project", "/w/project/.git:/w/project/.git:ro", "/w/cache:/cache"]);
    assert.ok(!args.some((a) => a.includes("docker.sock")));
    assert.ok(!args.includes("--privileged"));
  });

  it("passes only the given environment, and the command last", () => {
    const env = args.flatMap((a, i) => (a === "--env" ? [args[i + 1].split("=")[0]] : []));
    assert.deepEqual(env.sort(), ["CI", "EXTRA", "HOME", "NEXT_TELEMETRY_DISABLED", "PLAYWRIGHT_BROWSERS_PATH", "npm_config_cache", "npm_config_update_notifier"]);
    assert.deepEqual(args.slice(-4), ["--entrypoint", "npm", "img", "test"]);
  });

  it("names the default image after the Node major and the Dockerfile", () => {
    const a = defaultSandboxImage("24");
    assert.match(a.tag, /^aso-sandbox:node24-[0-9a-f]{12}$/);
    assert.match(a.dockerfile, /^FROM node:24-bookworm\n/);
    assert.equal(defaultSandboxImage("24").tag, a.tag, "stable tag, so the image is built once");
    assert.notEqual(defaultSandboxImage("22").tag, a.tag);
  });

  it("refuses to run outside the work directory", async () => {
    const sandbox = new DockerSandbox({ workDir: "/w", image: "img" });
    await assert.rejects(sandbox.run(["true"], { cwd: "/etc", timeoutMs: 1000 }), /not inside the work directory/);
    await assert.rejects(sandbox.run(["true"], { cwd: "/w", timeoutMs: 1000 }), /not inside the work directory/);
  });
});

const dockerUsable = (() => {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("Docker sandbox (real containers)", { skip: dockerUsable ? false : "Docker is not available" }, () => {
  // A small stock image keeps this fast; the real default adds browser libraries on top.
  const image = `node:${process.versions.node.split(".")[0]}-bookworm-slim`;
  let root: string;
  let workDir: string;
  let repo: string;
  let sandbox: DockerSandbox;
  const node = (code: string, timeoutMs = 60_000) => sandbox.run(["node", "-e", code], { cwd: repo, timeoutMs });

  before(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "aso-sandbox-"));
    workDir = path.join(root, "work");
    repo = path.join(workDir, "project");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(path.join(root, "secret.txt"), "top secret\n");
    sandbox = new DockerSandbox({ workDir, image });
    await sandbox.prepare();
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("runs in the checkout and writes files owned by the worker's user", async () => {
    const r = await node(`require("fs").writeFileSync("out.txt", process.cwd())`);
    assert.equal(r.exitCode, 0, r.output);
    const file = path.join(repo, "out.txt");
    assert.equal(execFileSync("cat", [file], { encoding: "utf8" }), repo);
    assert.equal(statSync(file).uid, os.userInfo().uid);
  });

  it("cannot see files outside the checkout or the worker's environment", async () => {
    process.env.ASO_SANDBOX_TEST_SECRET = "s3cret";
    try {
      const r = await node(
        `const fs = require("fs");
         console.log(JSON.stringify({
           secret: fs.existsSync(${JSON.stringify(path.join(root, "secret.txt"))}),
           home: fs.existsSync(${JSON.stringify(os.homedir())}),
           env: process.env.ASO_SANDBOX_TEST_SECRET ?? null,
           ci: process.env.CI,
         }))`,
      );
      assert.equal(r.exitCode, 0, r.output);
      assert.deepEqual(JSON.parse(r.output.trim()), { secret: false, home: false, env: null, ci: "1" });
    } finally {
      delete process.env.ASO_SANDBOX_TEST_SECRET;
    }
  });

  it("cannot change .git or the image, and gets no root", async () => {
    const r = await node(
      `const fs = require("fs");
       const tryWrite = (f) => { try { fs.writeFileSync(f, "x"); return "written"; } catch (e) { return e.code; } };
       console.log(JSON.stringify({ hook: tryWrite(".git/hooks/post-checkout"), usr: tryWrite("/usr/local/bin/x"), uid: process.getuid() }))`,
    );
    assert.equal(r.exitCode, 0, r.output);
    const out = JSON.parse(r.output.trim());
    assert.equal(out.hook, "EROFS");
    assert.ok(["EROFS", "EACCES"].includes(out.usr), out.usr);
    assert.equal(out.uid, os.userInfo().uid);
    assert.ok(!existsSync(path.join(repo, ".git/hooks/post-checkout")));
  });

  it("reports the exit code of a failing command", async () => {
    const r = await node("process.exit(3)");
    assert.equal(r.exitCode, 3);
  });

  it("rejects a program that does not exist in the image", async () => {
    await assert.rejects(sandbox.run(["no-such-program"], { cwd: repo, timeoutMs: 30_000 }), /not installed in the sandbox image/);
  });

  it("kills a command that runs too long and leaves no container behind", async () => {
    const r = await node("setTimeout(() => {}, 600000)", 3000);
    assert.equal(r.timedOut, true);
    const left = execFileSync("docker", ["ps", "-aq", "--filter", "name=aso-job-", "--filter", "ancestor=" + image], { encoding: "utf8" }).trim();
    assert.equal(left, "");
  });
});
