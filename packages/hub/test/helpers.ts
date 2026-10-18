import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startHub, type HubHandle, type HubOptions, type LlmAdapter, type LlmRequest, type LlmResponse } from "@aso/hub";
import {
  createMessage,
  parseAgentMessage,
  type AgentMessage,
  type HardwareProfile,
} from "@aso/shared";

process.env.ASO_LOG_LEVEL ??= "error";
// Never read or write the real ~/.config/aso from tests.
process.env.ASO_CONFIG_DIR = mkdtempSync(path.join(os.tmpdir(), "aso-config-"));

/** Every test Hub requires this token. */
export const TOKEN = "aso_test-token-0123456789";
const AUTH = `Authorization: Bearer ${TOKEN}`;

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
  const { stdout } = await promisify(execFile)("git", ["-c", `http.extraHeader=${AUTH}`, ...args], { cwd, env: GIT_ENV, encoding: "utf8" });
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
  /** Bare repo acting as the remote "origin" (when withHub was given origin: true). */
  originDir?: string;
  gitUrl: string;
}

export async function withHub(
  fn: (ctx: HubContext) => Promise<void>,
  opts: Partial<HubOptions> & { files?: Record<string, string>; origin?: boolean } = {},
) {
  const { files, origin, ...hubOpts } = opts;
  const repoDir = makeTargetRepo(files);
  let originDir: string | undefined;
  if (origin) {
    // A bare repository standing in for GitHub.
    originDir = tempDir("aso-origin-");
    git(originDir, "init", "--quiet", "--bare", "--initial-branch=main");
    git(repoDir, "remote", "add", "origin", originDir);
    git(repoDir, "push", "--quiet", "origin", "main");
  }
  // Port 0: test files run in parallel processes, so let the OS pick free ports.
  const hub = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", token: TOKEN, ...hubOpts });
  const port = hub.port;
  try {
    await fn({ hub, port, repoDir, originDir, gitUrl: `http://127.0.0.1:${port}/git/project.git` });
  } finally {
    await hub.close();
    rmSync(repoDir, { recursive: true, force: true });
    if (originDir) rmSync(originDir, { recursive: true, force: true });
  }
}

export type TestClient = Awaited<ReturnType<typeof connect>>;

/** Minimal test client that queues parsed inbound messages. */
export async function connect(port: number, token: string | null = TOKEN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: token ? { authorization: `Bearer ${token}` } : {} } as never);
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
    ramGiB?: number;
    docker?: boolean;
    mbps?: number;
    resume?: { taskId: string; job: "implement" | "test" };
    supervisor?: "systemd";
    updates?: "package";
    version?: string;
    hostname?: string;
    slots?: number;
    running?: Array<{ taskId: string; job: "implement" | "test" }>;
  } = {},
) {
  const c = await connect(port);
  c.send(
    createMessage("NODE_REGISTRATION", nodeId, {
      nodeKind: "worker",
      version: opts.version ?? "test",
      hardware: { ...hardware(opts), hostname: opts.hostname ?? "test" },
      resume: opts.resume,
      supervisor: opts.supervisor,
      updates: opts.updates,
      slots: opts.slots,
      running: opts.running,
    }),
  );
  const ack = await c.next();
  assert.equal(ack.type, "REGISTRATION_ACK");
  return c;
}

export async function postTask(port: number, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export async function getTask(port: number, id: string) {
  return (await (await fetch(`http://127.0.0.1:${port}/api/tasks/${id}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Record<string, any>;
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

// ---- Scripted model (stands in for the Anthropic API in tests) ----

export type Block = Record<string, unknown>;
export const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
export const text = (t: string): Block => ({ type: "text", text: t });
export const reply = (content: Block[], stopReason = "tool_use", tokens = 1000): LlmResponse => ({
  content: content as unknown as LlmResponse["content"],
  stopReason,
  model: "claude-opus-5-5",
  tokens: { inputTokens: tokens, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

/** Stand-in model: returns whatever the script says for the n-th call. */
export class ScriptedModel implements LlmAdapter {
  readonly name = "scripted";
  readonly model: string;
  readonly requests: LlmRequest[] = [];
  private readonly script: (req: LlmRequest, n: number) => LlmResponse | Promise<LlmResponse>;
  constructor(script: (req: LlmRequest, n: number) => LlmResponse | Promise<LlmResponse>, model = "claude-opus-5-5") {
    this.script = script;
    this.model = model;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    return this.script(req, this.requests.length - 1);
  }
}

/** Tool results the model received in its latest request, keyed by tool_use_id. */
export function lastToolResults(req: LlmRequest): Record<string, { content: string; is_error?: boolean }> {
  const last = req.messages.at(-1)!;
  const out: Record<string, { content: string; is_error?: boolean }> = {};
  for (const b of last.content as Array<Record<string, any>>) if (b.type === "tool_result") out[b.tool_use_id] = b as never;
  return out;
}

