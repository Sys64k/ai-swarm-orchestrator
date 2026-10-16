import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { JobRunner, unconfiguredExecutor, type CommandRunner } from "@aso/worker";

process.env.ASO_LOG_LEVEL ??= "error";

const root = mkdtempSync(path.join(os.tmpdir(), "aso-install-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A stand-in `npm ci`: creates node_modules, or fails when told to. */
function fakeNpm(fail = () => false) {
  const calls: string[][] = [];
  const commands: CommandRunner = {
    kind: "host",
    run: async (argv, opts) => {
      calls.push([...argv]);
      if (fail()) return { exitCode: 1, signal: null, timedOut: false, output: "npm error ERESOLVE", durationMs: 1 };
      mkdirSync(path.join(opts.cwd, "node_modules"), { recursive: true });
      return { exitCode: 0, signal: null, timedOut: false, output: "added 3 packages", durationMs: 1 };
    },
  };
  return { calls, commands };
}

const runner = (commands: CommandRunner) =>
  new JobRunner({ workDir: root, gitUrl: () => "unused", nodeId: "w", executor: unconfiguredExecutor, send: () => undefined, commands });

describe("installing a checkout's dependencies", () => {
  it("runs npm ci once per lockfile, again when it changes, and never without one", async () => {
    const dir = mkdtempSync(path.join(root, "repo-"));
    const npm = fakeNpm();
    const jobs = runner(npm.commands);

    assert.deepEqual(await jobs.installDependencies(dir), { ok: true, ran: false, output: "" }, "no lockfile: nothing to install");
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3,"v":1}');
    assert.equal((await jobs.installDependencies(dir)).ran, true);
    assert.deepEqual(npm.calls, [["npm", "ci", "--no-audit", "--no-fund"]]);
    assert.equal((await jobs.installDependencies(dir)).ran, false, "already installed from this lockfile");

    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3,"v":2}');
    assert.equal((await jobs.installDependencies(dir)).ran, true, "main gained a dependency");
    rmSync(path.join(dir, "node_modules"), { recursive: true });
    assert.equal((await jobs.installDependencies(dir)).ran, true, "node_modules went away");
    assert.equal(npm.calls.length, 3);
  });

  it("reports a failed install and tries again next time", async () => {
    const dir = mkdtempSync(path.join(root, "repo-"));
    writeFileSync(path.join(dir, "package-lock.json"), "{}");
    let failing = true;
    const npm = fakeNpm(() => failing);
    const jobs = runner(npm.commands);
    assert.deepEqual(await jobs.installDependencies(dir), { ok: false, ran: true, output: "npm error ERESOLVE" });
    assert.ok(!existsSync(path.join(dir, "node_modules", ".aso-lockfile-sha256")), "no stamp after a failure");
    failing = false;
    assert.equal((await jobs.installDependencies(dir)).ok, true);
    assert.equal(npm.calls.length, 2);
  });
});
