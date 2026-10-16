import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import si from "systeminformation";
import { MAX_WORKER_SLOTS, createLogger, type HardwareProfile } from "@aso/shared";

const BENCH_BYTES = 64 * 1024 * 1024;
const BENCH_CHUNK = 4 * 1024 * 1024;

const exec = promisify(execFile);
const log = createLogger("worker");
const GiB = 1024 ** 3;
/** What one job needs: an agent's npm installs and builds, or a headless browser for e2e tests. */
const THREADS_PER_SLOT = 2;
const RAM_PER_SLOT = 6 * GiB;
/** The default stays modest; `--slots` goes up to MAX_WORKER_SLOTS. */
const DEFAULT_MAX_SLOTS = 4;

export type SandboxKind = "docker" | "none" | "custom";

/**
 * How many jobs a worker runs at once unless told otherwise: one per THREADS_PER_SLOT and
 * RAM_PER_SLOT, at most DEFAULT_MAX_SLOTS. Without the Docker sandbox, jobs share this
 * machine's ports and processes, so they run one at a time.
 */
export function defaultSlots(hardware: Pick<HardwareProfile, "cpu" | "memory">, sandbox: SandboxKind): number {
  if (sandbox === "none") return 1;
  const fit = Math.min(Math.floor(hardware.cpu.logicalCores / THREADS_PER_SLOT), Math.floor(hardware.memory.totalBytes / RAM_PER_SLOT));
  return Math.max(1, Math.min(DEFAULT_MAX_SLOTS, fit));
}

/** The slots a worker uses: what was asked for (clamped to 1..MAX_WORKER_SLOTS), else `defaultSlots`. */
export function resolveSlots(requested: number | undefined, hardware: Pick<HardwareProfile, "cpu" | "memory">, sandbox: SandboxKind): number {
  if (requested === undefined) return defaultSlots(hardware, sandbox);
  return Math.max(1, Math.min(MAX_WORKER_SLOTS, Math.floor(requested)));
}

/** Collect the hardware profile the Hub uses for capability-based task routing. */
export async function profileHardware(workDir: string): Promise<HardwareProfile> {
  // Before the scan, not beside it: systeminformation runs some commands synchronously, and
  // while they block the event loop the probe's timeout fires late and discards Docker's answer.
  const docker = await probeDocker();
  if ("error" in docker) log.warn(`Docker is not available: ${docker.error}`);
  const [cpu, mem, distro, disks, writeMBps] = await Promise.all([
    si.cpu(),
    si.mem(),
    distroName(),
    si.diskLayout().catch(() => []),
    measureWriteMBps(workDir),
  ]);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    distro,
    cpu: { brand: cpu.brand, physicalCores: cpu.physicalCores, logicalCores: cpu.cores },
    memory: { totalBytes: mem.total, availableBytes: mem.available },
    disks: disks.map((d) => ({ name: d.name, type: d.type, sizeBytes: d.size })),
    docker: "version" in docker ? { available: true, version: docker.version } : { available: false },
    storage: { workDir, writeMBps },
  };
}

/**
 * The OS name and version, such as "Ubuntu 26.04.1 LTS", from os-release on Linux. Not
 * systeminformation's osInfo(): it runs `hostname -f` synchronously, which blocks the worker
 * for minutes on a machine whose own name does not resolve.
 */
export async function distroName(files = ["/etc/os-release", "/usr/lib/os-release"]): Promise<string> {
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text !== undefined) return osReleaseName(text) || `${os.type()} ${os.release()}`;
  }
  return `${os.type()} ${os.release()}`;
}

/** PRETTY_NAME from os-release, else NAME and VERSION_ID; empty when it has neither. */
export function osReleaseName(text: string): string {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) fields.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  return fields.get("PRETTY_NAME") || [fields.get("NAME"), fields.get("VERSION_ID")].filter(Boolean).join(" ");
}

export interface LoadMetrics {
  memoryAvailableBytes: number;
  cpuLoadPercent: number;
  dockerAvailable: boolean;
}

/** A heartbeat's metrics, and why Docker did not answer (kept on the worker, for its log). */
export async function sampleLoad(): Promise<{ load: LoadMetrics; dockerError?: string }> {
  const [mem, load, docker] = await Promise.all([si.mem(), si.currentLoad(), probeDocker()]);
  return {
    load: {
      memoryAvailableBytes: mem.available,
      cpuLoadPercent: Math.min(100, Math.max(0, Math.round(load.currentLoad * 10) / 10)),
      dockerAvailable: "version" in docker,
    },
    dockerError: "error" in docker ? docker.error : undefined,
  };
}

/**
 * The Docker daemon's version, or undefined when none answers (not merely when the CLI is
 * installed). Asks the `docker` CLI, as the sandbox does, so it follows the current Docker
 * context and DOCKER_HOST: rootless Docker and Docker Desktop do not listen on
 * /var/run/docker.sock, the only socket systeminformation checks.
 */
export async function dockerServerVersion(docker = "docker"): Promise<string | undefined> {
  const probe = await probeDocker(docker);
  return "version" in probe ? probe.version : undefined;
}

export type DockerProbe = { version: string } | { error: string };

const DOCKER_TIMEOUT_MS = 10_000;

/** Like `dockerServerVersion`, but says why Docker did not answer, so the worker can log it. */
export async function probeDocker(docker = "docker"): Promise<DockerProbe> {
  try {
    const { stdout } = await exec(docker, ["version", "--format", "{{.Server.Version}}"], { timeout: DOCKER_TIMEOUT_MS });
    const version = stdout.trim();
    return version ? { version } : { error: "`docker version` printed no server version" };
  } catch (err) {
    return { error: dockerFailure(err as ExecError) };
  }
}

type ExecError = NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: string };

/** One line on why `docker version` failed: the CLI is missing, it hung, or the daemon's own message. */
export function dockerFailure(err: ExecError): string {
  if (err.code === "ENOENT") return "the docker CLI is not on PATH";
  if (err.killed && err.signal === "SIGTERM") return `\`docker version\` did not answer within ${DOCKER_TIMEOUT_MS / 1000} s`;
  const stderr = err.stderr?.trim().split("\n").find((line) => line.trim()) ?? "";
  return stderr || err.message.split("\n")[0];
}

/**
 * Sequential write benchmark in the work directory, where task checkouts live, so the result
 * reflects the storage that builds and migrations will actually use.
 */
async function measureWriteMBps(workDir: string): Promise<number> {
  await mkdir(workDir, { recursive: true });
  const file = path.join(workDir, `.aso-io-bench-${process.pid}`);
  const chunk = randomBytes(BENCH_CHUNK);
  const handle = await open(file, "w");
  try {
    const start = process.hrtime.bigint();
    for (let written = 0; written < BENCH_BYTES; written += BENCH_CHUNK) await handle.write(chunk);
    await handle.sync();
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    return Math.round(BENCH_BYTES / 1024 / 1024 / seconds);
  } finally {
    await handle.close();
    await rm(file, { force: true });
  }
}
