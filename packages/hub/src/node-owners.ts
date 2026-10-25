import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "@aso/shared";
import { JsonFileWriter } from "./push/json-file.js";

const log = createLogger("node-owners");

const FILE = "node-owners.json";

/** A worker key id, or null for the Hub's own token. */
export type Owner = string | null;

/** The node ids `tasks` still name: held for them, or theirs to push to. */
export function nodeIdsInUse(tasks: Iterable<{ nodeId?: string; qaNodeId?: string }>): Set<string> {
  const ids = new Set<string>();
  for (const t of tasks) for (const id of [t.nodeId, t.qaNodeId]) if (id) ids.add(id);
  return ids;
}

/** node id → who registered it. */
const OwnersSchema = z.record(z.string(), z.string().nullable());

/**
 * Which credential each node id registered with, so no other credential can take that id, or
 * the jobs held for it, or push to its task branches. Saved with the Hub's state: right after a
 * restart the jobs held for a worker still belong to its credential. The Hub prunes it on each
 * start to the node ids a task still names, so it doesn't grow with every worker start.
 */
export class NodeOwners {
  private readonly writer: JsonFileWriter | undefined;

  private constructor(
    private readonly owners: Map<string, Owner>,
    file?: string,
  ) {
    this.writer = file ? new JsonFileWriter(file, 0o600) : undefined;
  }

  /** Owners saved in `<dir>/node-owners.json` (owner-only), or in memory without a `dir`. */
  static async open(dir?: string): Promise<NodeOwners> {
    if (!dir) return new NodeOwners(new Map());
    const file = path.join(dir, FILE);
    let owners = new Map<string, Owner>();
    try {
      owners = new Map(Object.entries(OwnersSchema.parse(JSON.parse(await readFile(file, "utf8")))));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${file} is unreadable, starting without node owners: ${(err as Error).message}`);
    }
    return new NodeOwners(owners, file);
  }

  /** Who registered `nodeId`, or undefined when nobody has. */
  ownerOf(nodeId: string): Owner | undefined {
    return this.owners.get(nodeId);
  }

  /** The node ids registered with key `keyId`. */
  nodesOf(keyId: string): Set<string> {
    return new Set([...this.owners].filter(([, owner]) => owner === keyId).map(([nodeId]) => nodeId));
  }

  /** Record who registered `nodeId`; saved in the background. */
  record(nodeId: string, owner: Owner): void {
    if (this.owners.get(nodeId) === owner) return;
    this.owners.set(nodeId, owner);
    this.persist();
  }

  /** Forget every node id not in `inUse`. */
  prune(inUse: ReadonlySet<string>): void {
    let removed = 0;
    for (const nodeId of [...this.owners.keys()]) {
      if (inUse.has(nodeId)) continue;
      this.owners.delete(nodeId);
      removed++;
    }
    if (removed) this.persist();
  }

  private persist(): void {
    void this.writer?.write(Object.fromEntries(this.owners));
  }
}
