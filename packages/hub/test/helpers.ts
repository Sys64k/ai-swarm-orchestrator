import assert from "node:assert/strict";
import { startHub, type HubHandle, type HubOptions } from "@aso/hub";
import { createMessage, parseAgentMessage, type AgentMessage, type HardwareProfile, type WorkerRole } from "@aso/shared";

process.env.ASO_LOG_LEVEL ??= "error";

let nextPort = 18_000 + Math.floor(Math.random() * 500) * 2;

export async function withHub(fn: (hub: HubHandle, port: number) => Promise<void>, opts: Partial<HubOptions> = {}) {
  const port = nextPort++;
  const hub = await startHub({ targetDir: "/tmp/target", port, host: "127.0.0.1", ...opts });
  try {
    await fn(hub, port);
  } finally {
    await hub.close();
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

/** Connect and register a worker, consuming the ack. */
export async function worker(
  port: number,
  nodeId: string,
  opts: { roles?: WorkerRole[]; ramGiB?: number; docker?: boolean; mbps?: number } = {},
) {
  const c = await connect(port);
  c.send(
    createMessage("NODE_REGISTRATION", nodeId, {
      nodeKind: "worker",
      version: "test",
      roles: opts.roles ?? ["backend", "frontend", "qa", "devops"],
      hardware: hardware(opts),
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
