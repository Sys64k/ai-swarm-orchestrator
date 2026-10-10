#!/usr/bin/env node
/**
 * Architect (lead agent) entrypoint. Runs inside a persistent tmux session on the Hub
 * machine, connects to the Hub over WebSocket, and turns project requirements into JSON
 * task specs. It never writes code itself.
 *
 * Phase 1: connect + reconnect only. Planning logic arrives with the protocol and LLM gateway.
 */
import { randomUUID } from "node:crypto";
import {
  HEARTBEAT_INTERVAL_MS,
  createLogger,
  createMessage,
  parseAgentMessage,
  resolveHubUrl,
} from "@aso/shared";

const log = createLogger("architect");

function parseHubArg(argv: string[]): string {
  const i = argv.indexOf("--hub");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "127.0.0.1";
}

const url = resolveHubUrl(parseHubArg(process.argv.slice(2)));
const nodeId = `architect-${randomUUID()}`;
let attempt = 0;
let keepalive: NodeJS.Timeout | undefined;

function connect(): void {
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    attempt = 0;
    log.info(`connected to hub ${url.href}`);
    ws.send(JSON.stringify(createMessage("NODE_REGISTRATION", nodeId, { nodeKind: "architect", version: "0.1.0" })));
  });
  ws.addEventListener("message", (evt) => {
    const parsed = parseAgentMessage(String(evt.data));
    if (!parsed.ok) return log.warn(`invalid message from hub: ${parsed.reason}`, parsed.issues);
    const msg = parsed.message;
    if (msg.type === "REGISTRATION_ACK") {
      log.info(`registered as ${msg.payload.nodeId}`);
      // Keeps the Hub's liveness check satisfied; the Architect has no load metrics to report.
      clearInterval(keepalive);
      keepalive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(createMessage("STATUS_UPDATE", nodeId, { state: "idle" })));
        }
      }, HEARTBEAT_INTERVAL_MS);
    }
    else if (msg.type === "PROTOCOL_ERROR") log.error(`hub rejected message: ${msg.payload.reason}`, msg.payload.issues);
    else log.debug(`${msg.type} received`, msg.payload);
  });
  ws.addEventListener("close", () => {
    clearInterval(keepalive);
    const delay = Math.min(30_000, 1000 * 2 ** attempt++);
    log.warn(`disconnected from hub, retrying in ${delay}ms`);
    setTimeout(connect, delay);
  });
  ws.addEventListener("error", () => {
    /* close handler drives reconnect */
  });
}

connect();
