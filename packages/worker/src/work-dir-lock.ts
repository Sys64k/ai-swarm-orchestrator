import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Lock file a worker keeps in its work directory while it runs. */
export const WORK_DIR_LOCK = "worker.lock";

export class WorkDirLockedError extends Error {}

export interface WorkDirLock {
  /** Remove the lock, unless another worker has taken it over since. */
  release(): void;
}

interface LockOwner {
  pid: number;
  /** Linux boot id: a pid from an earlier boot says nothing about this one. */
  bootId?: string;
  token: string;
  startedAt: string;
}

export interface LockEnv {
  pid: number;
  bootId: string | undefined;
  isAlive(pid: number): boolean;
}

const systemEnv: LockEnv = { pid: process.pid, bootId: readBootId(), isAlive: pidAlive };

/**
 * Claim `workDir` for this worker. Two workers sharing a work directory would overwrite each
 * other's checkouts, so a second one refuses to start. A lock left behind by a worker that
 * crashed or was killed (its process is gone, or the machine rebooted) is taken over.
 */
export function lockWorkDir(workDir: string, env: LockEnv = systemEnv): WorkDirLock {
  mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, WORK_DIR_LOCK);
  const owner: LockOwner = { pid: env.pid, bootId: env.bootId, token: randomUUID(), startedAt: new Date().toISOString() };

  // Two attempts: the second follows removing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o644 });
      return heldLock(file, owner.token);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = readOwner(file);
    if (holder && holdsLock(holder, env)) {
      throw new WorkDirLockedError(
        `another worker (pid ${holder.pid}, started ${holder.startedAt}) is using ${workDir}. ` +
          `Stop it first (\`aso service status\` shows the service's pid), or give this worker its own --work-dir.`,
      );
    }
    removeIfUnchanged(file, holder?.token);
  }
  throw new WorkDirLockedError(`could not lock ${workDir}: another worker keeps claiming it`);
}

/** Whether the recorded worker still runs. */
export function holdsLock(holder: Pick<LockOwner, "pid" | "bootId">, env: LockEnv): boolean {
  if (holder.bootId && env.bootId && holder.bootId !== env.bootId) return false;
  return env.isAlive(holder.pid);
}

function heldLock(file: string, token: string): WorkDirLock {
  const release = () => {
    process.off("exit", release);
    removeIfUnchanged(file, token);
  };
  // Covers process.exit() from a signal handler; a SIGKILL leaves a stale lock, which the next start takes over.
  process.on("exit", release);
  return { release };
}

function readOwner(file: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LockOwner>;
    return Number.isInteger(parsed.pid) && typeof parsed.token === "string" ? (parsed as LockOwner) : undefined;
  } catch {
    return undefined;
  }
}

/** Delete the lock only if it is still the one we looked at (`token`), or unreadable when `token` is undefined. */
function removeIfUnchanged(file: string, token: string | undefined): void {
  if (readOwner(file)?.token !== token) return;
  try {
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readBootId(): string | undefined {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
