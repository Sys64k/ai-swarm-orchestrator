import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { HardwareProfile } from "@aso/shared";
import { holdsLock, lockWorkDir, startWorker, WORK_DIR_LOCK, WorkDirLockedError, type LockEnv } from "@aso/worker";

process.env.ASO_LOG_LEVEL ??= "error";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "aso-lock-"));
  dirs.push(d);
  return d;
};

/** A machine where `alive` pids run, booted as `bootId`. */
const env = (pid: number, alive: number[], bootId = "boot-1"): LockEnv => ({ pid, bootId, isAlive: (p) => alive.includes(p) });

describe("work directory lock", () => {
  it("lets one worker hold a work directory and refuses a second", () => {
    const dir = tempDir();
    const lock = lockWorkDir(dir, env(100, [100, 200]));
    assert.equal(JSON.parse(readFileSync(path.join(dir, WORK_DIR_LOCK), "utf8")).pid, 100);
    assert.throws(() => lockWorkDir(dir, env(200, [100, 200])), (err: Error) => err instanceof WorkDirLockedError && /pid 100/.test(err.message) && err.message.includes(dir));

    lock.release();
    assert.ok(!existsSync(path.join(dir, WORK_DIR_LOCK)));
    lockWorkDir(dir, env(200, [100, 200])).release();
  });

  it("creates a missing work directory", () => {
    const dir = path.join(tempDir(), "nested", "work");
    lockWorkDir(dir, env(1, [1])).release();
  });

  it("takes over a lock left by a worker that is gone", () => {
    const dir = tempDir();
    lockWorkDir(dir, env(100, [100])); // never released: the worker was SIGKILLed
    const lock = lockWorkDir(dir, env(200, [200]));
    assert.equal(JSON.parse(readFileSync(path.join(dir, WORK_DIR_LOCK), "utf8")).pid, 200);
    lock.release();
  });

  it("takes over a lock from an earlier boot, even if its pid is reused", () => {
    const dir = tempDir();
    lockWorkDir(dir, env(100, [100], "boot-1"));
    lockWorkDir(dir, env(200, [100, 200], "boot-2")).release();
    assert.equal(holdsLock({ pid: 100, bootId: "boot-1" }, env(1, [100], "boot-1")), true);
    assert.equal(holdsLock({ pid: 100 }, env(1, [100], "boot-2")), true, "no boot id recorded: trust the pid");
  });

  it("takes over an unreadable lock file", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, WORK_DIR_LOCK), "not json");
    lockWorkDir(dir, env(1, [1])).release();
  });

  it("never removes a lock another worker has taken over", () => {
    const dir = tempDir();
    const stale = lockWorkDir(dir, env(100, [100]));
    const current = lockWorkDir(dir, env(200, [200])); // 100 died; 200 took over
    stale.release();
    assert.equal(JSON.parse(readFileSync(path.join(dir, WORK_DIR_LOCK), "utf8")).pid, 200);
    current.release();
  });

  it("stops a second worker on the same directory before it connects, and frees it on stop", async () => {
    const dir = tempDir();
    const hardware: HardwareProfile = {
      hostname: "h",
      platform: "linux",
      distro: "x",
      cpu: { brand: "c", physicalCores: 1, logicalCores: 1 },
      memory: { totalBytes: 1, availableBytes: 1 },
      disks: [],
      docker: { available: false },
      storage: { workDir: dir, writeMBps: 1 },
    };
    // Nothing listens on port 1: the worker just keeps retrying in the background.
    const opts = { hub: "127.0.0.1:1", token: "t", workDir: dir, hardware, sandbox: "none" as const };
    const first = await startWorker(opts);
    try {
      await assert.rejects(startWorker(opts), WorkDirLockedError);
    } finally {
      first.stop();
    }
    (await startWorker(opts)).stop();
  });
});
