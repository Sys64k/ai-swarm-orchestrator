import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import dgram from "node:dgram";
import os from "node:os";
import { z } from "zod";
import { isPrivateAddress } from "./auth.js";
import { DEFAULT_DISCOVERY_PORT } from "./constants.js";
import { NO_TAILNET, replySource, tailnet, type Tailnet } from "./tailnet.js";

/**
 * Finding the Hub on the LAN without its address. A worker broadcasts a query over UDP; the Hub's
 * machine answers from its own address with the Hub's port. Anyone on the LAN can answer, so the
 * answer carries a proof only a holder of the worker's credential can make: an HMAC, keyed with
 * the credential's sha256 (all the Hub keeps of a worker key), over the worker's random nonce,
 * the port and the addresses the Hub answers from. The worker accepts an answer only from one of
 * those addresses, so a copied proof is no use from another machine, and its credential is never
 * sent to an impostor.
 */

const PROTOCOL_VERSION = 1;
/** UDP payloads stay far below one packet; anything larger isn't ours. */
const MAX_PACKET_BYTES = 2048;
/** Addresses an answer lists at most. */
const MAX_ADDRESSES = 32;

const Nonce = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const DiscoveryKeyIdSchema = z.string().regex(/^[0-9a-f]{32}$/);

/** What a proof covers: the worker's nonce, and where the Hub is (its port, and the addresses the answer comes from). */
export const DiscoveryClaimSchema = z.strictObject({
  nonce: Nonce.describe("The worker's nonce"),
  port: z.number().int().min(1).max(65535).describe("The Hub port the answer gives"),
  addresses: z.array(z.string().min(1).max(64)).min(1).max(MAX_ADDRESSES).describe("The addresses the answer comes from"),
});
export type DiscoveryClaim = z.infer<typeof DiscoveryClaimSchema>;

export const DiscoveryQuerySchema = z.strictObject({
  aso: z.literal("discover"),
  v: z.literal(PROTOCOL_VERSION),
  nonce: Nonce,
  /** Which credential the proof must use: a hash of its secret, not the secret. */
  key: DiscoveryKeyIdSchema,
});
export type DiscoveryQuery = z.infer<typeof DiscoveryQuerySchema>;

/** The addresses are the Hub machine's own: the answer must come from one of them. */
export const DiscoveryReplySchema = DiscoveryClaimSchema.extend({
  aso: z.literal("hub"),
  v: z.literal(PROTOCOL_VERSION),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DiscoveryReply = z.infer<typeof DiscoveryReplySchema>;

/** The secret a credential proves with (the input of `discoveryKeyId` and `discoveryProof`): its sha256 (hex), which is what the Hub stores of a worker key. */
export function discoverySecret(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

/** A credential's public id in queries: a hash of its secret, so it reveals nothing usable. */
export function discoveryKeyId(secret: string): string {
  return createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex").slice(0, 32);
}

export function discoveryProof(secret: string, claim: DiscoveryClaim): string {
  const message = ["aso-discovery", PROTOCOL_VERSION, claim.nonce, claim.port, [...claim.addresses].sort().join(",")].join("|");
  return createHmac("sha256", Buffer.from(secret, "hex")).update(message).digest("hex");
}

/** A new query for `credential`, with the nonce its answer must repeat. */
export function newDiscoveryQuery(credential: string, nonce = randomBytes(16).toString("base64url")): DiscoveryQuery {
  return { aso: "discover", v: PROTOCOL_VERSION, nonce, key: discoveryKeyId(discoverySecret(credential)) };
}

/** The answer to a query, with the proof for `claim` (which repeats the query's nonce). */
export function newDiscoveryReply(claim: DiscoveryClaim, proof: string): DiscoveryReply {
  return { aso: "hub", v: PROTOCOL_VERSION, ...claim, proof };
}

export function parseDiscoveryQuery(packet: Buffer): DiscoveryQuery | undefined {
  return parsePacket(packet, DiscoveryQuerySchema);
}

export function parseDiscoveryReply(packet: Buffer): DiscoveryReply | undefined {
  return parsePacket(packet, DiscoveryReplySchema);
}

function parsePacket<T>(packet: Buffer, schema: z.ZodType<T>): T | undefined {
  if (packet.length > MAX_PACKET_BYTES) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(packet.toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Hub address (`host:port`) an answer gives, if it is one to trust: it repeats our nonce,
 * comes from a private address the Hub listed, and its proof checks out with our credential.
 */
export function acceptDiscoveryReply(reply: DiscoveryReply, expect: { nonce: string; credential: string; from: string }): string | undefined {
  const from = expect.from.replace(/^::ffff:/, "");
  if (reply.nonce !== expect.nonce || !reply.addresses.includes(from) || !isPrivateAddress(from)) return undefined;
  const expected = Buffer.from(discoveryProof(discoverySecret(expect.credential), reply), "hex");
  const given = Buffer.from(reply.proof, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return `${from}:${reply.port}`;
}

type Interfaces = ReturnType<typeof os.networkInterfaces>;

const lanInterfaces = (interfaces: Interfaces) =>
  Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((i) => i.family === "IPv4" && !i.internal);

/** This machine's own LAN addresses (IPv4, not loopback): what a Hub's answer lists. */
export function localAddresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  return [...new Set(lanInterfaces(interfaces).map((i) => i.address))].slice(0, MAX_ADDRESSES);
}

/** Where a query goes: the limited broadcast, and each IPv4 network's own broadcast address. */
export function broadcastAddresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const directed = lanInterfaces(interfaces).map((i) => {
    const ip = ipv4ToInt(i.address);
    const mask = ipv4ToInt(i.netmask);
    return intToIpv4((ip | ~mask) >>> 0);
  });
  return [...new Set(["255.255.255.255", ...directed])];
}

const ipv4ToInt = (ip: string) => ip.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
const intToIpv4 = (n: number) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join(".");

export interface DiscoverOptions {
  /** UDP port the Hub's machine listens on. */
  port?: number;
  /** How long to wait for an answer. */
  timeoutMs?: number;
  /** Where to send the query (default: every broadcast address). */
  targets?: string[];
  /**
   * Tailnet peers to ask directly too. Default: this machine's, from `tailscale status`, unless
   * `targets` is given (then none, so a test asks only where it says). `NO_TAILNET`: none.
   */
  tailnet?: Tailnet;
}

/** Where the Hub was found, and which way the answer came. */
export interface FoundHub {
  address: string;
  via: "lan" | "tailnet";
}

/** How long a tailnet answer waits for a LAN one, which is preferred (shorter way). */
const LAN_GRACE_MS = 300;

/**
 * Ask where the Hub is: by broadcast on the LAN, and directly at each online Tailscale peer
 * (broadcasts don't cross Tailscale). Its `host:port`, or undefined when no trustworthy answer
 * came in time. A LAN answer is preferred over a tailnet one that arrives just before it.
 */
export async function discoverHub(credential: string, opts: DiscoverOptions = {}): Promise<string | undefined> {
  return (await locateHub(credential, opts))?.address;
}

/** Like `discoverHub`, and says which way the answer came. */
export async function locateHub(credential: string, opts: DiscoverOptions = {}): Promise<FoundHub | undefined> {
  const port = opts.port ?? DEFAULT_DISCOVERY_PORT;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const peers = (opts.tailnet ?? (opts.targets ? NO_TAILNET : await tailnet())).peers;
  const query = newDiscoveryQuery(credential);
  const packet = Buffer.from(JSON.stringify(query));
  const socket = dgram.createSocket("udp4");
  return new Promise<FoundHub | undefined>((resolve) => {
    const timers: NodeJS.Timeout[] = [];
    const finish = (found: FoundHub | undefined) => {
      for (const t of timers) clearTimeout(t);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(found);
    };
    socket.on("error", () => finish(undefined));
    // A LAN answer ends the wait; a tailnet one is kept, and used unless a LAN one follows soon.
    let tailnetAnswer: FoundHub | undefined;
    socket.on("message", (msg, rinfo) => {
      const reply = parseDiscoveryReply(msg);
      const address = reply && acceptDiscoveryReply(reply, { nonce: query.nonce, credential, from: rinfo.address });
      if (!address) return;
      const found: FoundHub = { address, via: replySource(rinfo.address) };
      if (found.via === "lan") return finish(found);
      if (tailnetAnswer) return;
      tailnetAnswer = found;
      timers.push(setTimeout(() => finish(found), LAN_GRACE_MS));
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const send = () => {
        for (const target of [...(opts.targets ?? broadcastAddresses()), ...peers]) socket.send(packet, port, target, () => undefined);
      };
      // UDP may drop a packet: ask three times within the wait.
      for (const at of [0, timeoutMs / 4, timeoutMs / 2]) timers.push(setTimeout(send, at));
      timers.push(setTimeout(() => finish(tailnetAnswer), timeoutMs));
    });
  });
}
