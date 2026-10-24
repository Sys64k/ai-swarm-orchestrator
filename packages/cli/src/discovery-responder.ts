import dgram from "node:dgram";
import {
  createLogger,
  DiscoveryProofSchema,
  localAddresses,
  newDiscoveryReply,
  parseDiscoveryQuery,
  type DiscoveryQuery,
  type DiscoveryReply,
} from "@aso/shared";

const log = createLogger("discovery");

/** Queries answered per window at most: a flood can't turn the Hub into a busy proof oracle. */
export const MAX_ANSWERS_PER_WINDOW = 30;
const WINDOW_MS = 10_000;

export interface ResponderOptions {
  /** UDP port to listen on. */
  port: number;
  /** The Hub's port, as other machines reach it. */
  hubPort: number;
  /** The proof for a query and the claim answering it, or undefined when the Hub doesn't know its credential. */
  prove: (query: DiscoveryQuery, claim: { port: number; addresses: string[] }) => Promise<string | undefined>;
  /** This machine's LAN addresses (default: read on each query, so a new DHCP lease is picked up). */
  addresses?: () => string[];
}

export interface DiscoveryResponder {
  /** The UDP port it answers on, once listening; undefined when it couldn't. */
  listening: Promise<number | undefined>;
  close(): Promise<void>;
}

/**
 * The answer to a query, if the Hub can prove it holds the query's credential. Silent otherwise:
 * a machine without a valid credential learns nothing, not even that a Hub is here.
 */
export async function answerQuery(query: DiscoveryQuery, opts: Pick<ResponderOptions, "hubPort" | "prove" | "addresses">): Promise<DiscoveryReply | undefined> {
  const addresses = (opts.addresses ?? localAddresses)();
  if (addresses.length === 0) return undefined;
  const claim = { port: opts.hubPort, addresses };
  const proof = await opts.prove(query, claim);
  return proof ? newDiscoveryReply({ nonce: query.nonce, ...claim }, proof) : undefined;
}

/**
 * Answer workers' LAN discovery queries on UDP `port`. It runs on the Hub's machine, outside a
 * container: broadcasts don't reach a container on Docker's bridge network. When the port can't
 * be had, the Hub runs on without it (workers then need --hub).
 */
export function startDiscoveryResponder(opts: ResponderOptions): DiscoveryResponder {
  const socket = dgram.createSocket("udp4");
  let window = { start: 0, count: 0 };
  socket.on("message", (msg, rinfo) => {
    const query = parseDiscoveryQuery(msg);
    if (!query) return;
    const now = Date.now();
    if (now - window.start >= WINDOW_MS) window = { start: now, count: 0 };
    if (++window.count > MAX_ANSWERS_PER_WINDOW) return;
    answerQuery(query, opts)
      .then((reply) => {
        if (!reply) return log.debug(`no credential for a discovery query from ${rinfo.address}`);
        socket.send(JSON.stringify(reply), rinfo.port, rinfo.address, (err) => err && log.debug(`could not answer ${rinfo.address}: ${err.message}`));
        log.debug(`told ${rinfo.address} where the Hub is`);
      })
      .catch((err: Error) => log.warn(`could not answer a discovery query: ${err.message}`));
  });
  const listening = new Promise<number | undefined>((resolve) => {
    socket.on("error", (err) => {
      log.warn(`LAN discovery is off (UDP ${opts.port}: ${err.message}); workers need --hub`);
      socket.close();
      resolve(undefined);
    });
    socket.bind(opts.port, () => {
      const { port } = socket.address();
      log.info(`answering workers' LAN discovery on UDP ${port}`);
      resolve(port);
    });
  });
  return {
    listening,
    close: () =>
      new Promise((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve(); // already closed after an error
        }
      }),
  };
}

/** A `prove` that asks the Hub's API, with the Hub's token. */
export function hubProver(hubUrl: string, token: string): ResponderOptions["prove"] {
  return async (query, claim) => {
    const res = await fetch(`${hubUrl}/api/discovery/proof`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ key: query.key, nonce: query.nonce, ...claim }),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`the Hub answered HTTP ${res.status}`);
    return DiscoveryProofSchema.parse(await res.json()).proof;
  };
}
