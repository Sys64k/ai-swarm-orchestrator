import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHub, type HubHandle, type HubOptions } from "@aso/hub";
import {
  createMessage,
  parseAgentMessage,
  type AgentMessage,
  type HardwareProfile,
  type WorkerRole,
} from "@aso/shared";

process.env.ASO_LOG_LEVEL ??= "error";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test",
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Async git, required for anything that talks to the in-process Hub over HTTP: a sync call
 * would block the event loop the Hub needs to answer it.
 */
export async function gitAsync(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  return stdout.trim();
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
}

export function tempDir(prefix = "aso-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A target project repository with one commit on main. */
export function makeTargetRepo(files: Record<string, string> = {}): string {
  const dir = tempDir("aso-target-");
  git(dir, "init", "--quiet", "--initial-branch=main");
  writeFiles(dir, { "README.md": "target\n", ...files });
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

export interface HubContext {
  hub: HubHandle;
  port: number;
  repoDir: string;
  gitUrl: string;
}

export async function withHub(
  fn: (ctx: HubContext) => Promise<void>,
  opts: Partial<HubOptions> & { files?: Record<string, string> } = {},
) {
  const { files, ...hubOpts } = opts;
  const repoDir = makeTargetRepo(files);
  // Port 0: test files run in parallel processes, so let the OS pick free ports.
  const hub = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", ...hubOpts });
  const port = hub.port;
  try {
    await fn({ hub, port, repoDir, gitUrl: `http://127.0.0.1:${port}/git/project.git` });
  } finally {
    await hub.close();
    rmSync(repoDir, { recursive: true, force: true });
  }
}

export type TestClient = Awaited<ReturnType<typeof connect>>;

/** Minimal test client that queues parsed inbound messages. */
export async function connect(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: AgentMessage[] = [];
  const waiters: Array<(m: AgentMessage) => void> = [];
  let closeCode: number | undefined;
  const closed = new Promise<number>((res) => ws.addEventListener("close", (e) => res((closeCode = e.code))));
  ws.addEventListener("message", (e) => {
    const r = parseAgentMessage(String(e.data));
    assert.ok(r.ok, "hub sent an invalid message");
    const w = waiters.shift();
    w ? w(r.message) : inbox.push(r.message);
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  return {
    ws,
    closed,
    send: (m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m)),
    next: (timeoutMs = 2000) =>
      new Promise<AgentMessage>((res, rej) => {
        const m = inbox.shift();
        if (m) return res(m);
        const t = setTimeout(() => rej(new Error("timed out waiting for message")), timeoutMs);
        waiters.push((msg) => (clearTimeout(t), res(msg)));
      }),
    /** Resolves true if no message arrives within `ms`. */
    quiet: (ms = 150) => new Promise<boolean>((res) => setTimeout(() => res(inbox.length === 0), ms)),
    closeCode: () => closeCode,
  };
}

export function hardware(opts: { ramGiB?: number; docker?: boolean; mbps?: number } = {}): HardwareProfile {
  const ram = (opts.ramGiB ?? 16) * 1024 ** 3;
  return {
    hostname: "test",
    platform: "linux",
    distro: "Ubuntu",
    cpu: { brand: "cpu", physicalCores: 8, logicalCores: 8 },
    memory: { totalBytes: ram, availableBytes: ram },
    disks: [],
    docker: { available: opts.docker ?? false },
    storage: { workDir: "/w", writeMBps: opts.mbps ?? 500 },
  };
}

/** Connect and register a fake worker, consuming the ack. */
export async function worker(
  port: number,
  nodeId: string,
  opts: {
    roles?: WorkerRole[];
    ramGiB?: number;
    docker?: boolean;
    mbps?: number;
    resume?: { taskId: string; job: "implement" | "test" };
  } = {},
) {
  const c = await connect(port);
  c.send(
    createMessage("NODE_REGISTRATION", nodeId, {
      nodeKind: "worker",
      version: "test",
      roles: opts.roles ?? ["backend", "frontend", "qa", "devops"],
      hardware: hardware(opts),
      resume: opts.resume,
    }),
  );
  const ack = await c.next();
  assert.equal(ack.type, "REGISTRATION_ACK");
  return c;
}

export async function postTask(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export async function getTask(port: number, id: string) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/tasks/${id}`)).json()) as Record<string, any>;
}

/** Poll until `check` returns a truthy value. */
export async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 10_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Clone the Hub repo over HTTP, commit files on task/<id>, push it. Returns the commit. */
export async function pushTaskBranch(gitUrl: string, taskId: string, files: Record<string, string>): Promise<string> {
  const dir = tempDir("aso-clone-");
  try {
    await gitAsync(dir, "clone", "--quiet", gitUrl, ".");
    git(dir, "checkout", "--quiet", "-b", `task/${taskId}`);
    writeFiles(dir, files);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", `work on ${taskId}`);
    await gitAsync(dir, "push", "--quiet", "origin", `task/${taskId}`);
    return git(dir, "rev-parse", "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
