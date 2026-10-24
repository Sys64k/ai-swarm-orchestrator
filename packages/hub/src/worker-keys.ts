import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger, WORKER_KEY_PREFIX } from "@aso/shared";

const log = createLogger("worker-keys");

/** How long a join code works: long enough to set up the new machine. */
export const JOIN_CODE_TTL_MS = 30 * 60_000;
/** Join codes waiting to be used at once; creating more drops the oldest. */
const MAX_CODES = 20;
/** How often a key's last use is written down (it is checked on every request). */
const LAST_USED_RESOLUTION_MS = 60_000;
const FILE = "worker-keys.json";

const RecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** sha256 of the key: the key itself is only ever shown to the machine that joined. */
  hash: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  revokedAt: z.string().optional(),
});
type WorkerKeyRecord = z.infer<typeof RecordSchema>;

/** A worker key as the API shows it: never the key or its hash. */
export interface WorkerKeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Keys for worker machines, one per machine, instead of the Hub's own token. A key lets a machine
 * do worker work only (the worker connection, the projects' Git, which push to task branches
 * only) and can be revoked on its own. A machine gets one by redeeming a one-time join code,
 * which someone with the Hub's token created; the Hub keeps only the key's hash.
 */
export class WorkerKeys {
  private readonly codes = new Map<string, { expiresAt: number; name?: string }>();
  private readonly lastUsedSaved = new Map<string, number>();

  private saving: Promise<unknown> = Promise.resolve();

  private constructor(
    private records: WorkerKeyRecord[],
    private readonly file?: string,
  ) {}

  /** Keys saved in `<dir>/worker-keys.json` (owner-only), or in memory without a `dir`. */
  static async open(dir?: string): Promise<WorkerKeys> {
    if (!dir) return new WorkerKeys([]);
    const file = path.join(dir, FILE);
    let records: WorkerKeyRecord[] = [];
    try {
      records = z.array(RecordSchema).parse(JSON.parse(await readFile(file, "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${file} is unreadable, starting without worker keys: ${(err as Error).message}`);
    }
    return new WorkerKeys(records, file);
  }

  /** A one-time code a new machine trades for its key. `name` labels the key (default: the machine's hostname). */
  createJoinCode(name?: string, now = Date.now()): { code: string; expiresAt: string } {
    for (const [code, c] of this.codes) if (c.expiresAt <= now) this.codes.delete(code);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(18).toString("base64url");
    const expiresAt = now + JOIN_CODE_TTL_MS;
    this.codes.set(code, { expiresAt, ...(name ? { name } : {}) });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Whether `code` is a join code that would work now (a valid code is never rate-limited). */
  hasCode(code: string, now = Date.now()): boolean {
    const entry = this.codes.get(code);
    return entry !== undefined && entry.expiresAt > now;
  }

  /** Trade a join code for a new key (once); undefined for an unknown, used or expired code. */
  async join(code: string, machine: string, now = Date.now()): Promise<{ id: string; name: string; key: string } | undefined> {
    const entry = this.codes.get(code);
    this.codes.delete(code);
    if (!entry || entry.expiresAt <= now) return undefined;
    const key = `${WORKER_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    const record: WorkerKeyRecord = { id: randomUUID().slice(0, 8), name: entry.name ?? machine, hash: sha256(key), createdAt: new Date(now).toISOString() };
    this.records.push(record);
    try {
      await this.save();
    } catch (err) {
      this.records = this.records.filter((r) => r !== record); // nobody holds it: don't keep it
      throw err;
    }
    log.info(`worker key ${record.id} created for ${record.name}`);
    return { id: record.id, name: record.name, key };
  }

  /** The key's record if `key` is a valid, unrevoked worker key. */
  verify(key: string, now = Date.now()): WorkerKeyView | undefined {
    if (!key.startsWith(WORKER_KEY_PREFIX)) return undefined;
    const hash = Buffer.from(sha256(key), "hex");
    const record = this.records.find((r) => {
      const stored = Buffer.from(r.hash, "hex");
      return stored.length === hash.length && timingSafeEqual(stored, hash); // a damaged entry matches nothing
    });
    if (!record || record.revokedAt) return undefined;
    if (now - (this.lastUsedSaved.get(record.id) ?? 0) >= LAST_USED_RESOLUTION_MS) {
      this.lastUsedSaved.set(record.id, now);
      record.lastUsedAt = new Date(now).toISOString();
      this.save().catch((err: Error) => log.warn(`could not save when worker key ${record.id} was last used: ${err.message}`));
    }
    return view(record);
  }

  /** Whether the key with this id exists and isn't revoked (connections made with it re-check this). */
  isActive(id: string): boolean {
    return this.records.some((r) => r.id === id && !r.revokedAt);
  }

  list(): WorkerKeyView[] {
    return this.records.map(view);
  }

  /** Revoke a key by id; returns it, or undefined when there is no such key. */
  async revoke(id: string, now = Date.now()): Promise<WorkerKeyView | undefined> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return undefined;
    if (!record.revokedAt) {
      record.revokedAt = new Date(now).toISOString();
      await this.save();
      log.info(`worker key ${record.id} (${record.name}) revoked`);
    }
    return view(record);
  }

  /**
   * Write the keys (temporary file, owner-only, then rename), one save at a time. Unlike other
   * state, a failure is thrown: a join that wasn't saved would lose its key, and a revocation that
   * wasn't saved would let the key back in after a restart.
   */
  private save(): Promise<void> {
    const file = this.file;
    if (!file) return Promise.resolve();
    const json = JSON.stringify(this.records, null, 2);
    const run = this.saving.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, json, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    this.saving = run.catch(() => undefined);
    return run;
  }
}

function view({ hash: _hash, ...rest }: WorkerKeyRecord): WorkerKeyView {
  return rest;
}
