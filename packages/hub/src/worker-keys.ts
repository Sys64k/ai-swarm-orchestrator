import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JsonFileWriter } from "./push/json-file.js";
import { describeScope, type KeyScope } from "./worker-scope.js";
import { addOutcome, JOB_OUTCOMES, type JobOutcome, type TrackRecord } from "./track-record.js";
import { createLogger, discoveryKeyId, discoverySecret, WORKER_KEY_PREFIX } from "@aso/shared";

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
  /** The projects it may use; absent: all. */
  projects: z.array(z.string()).optional(),
  /** Absent (keys from before scopes): trusted. */
  trusted: z.boolean().optional(),
  budgetUsd: z.number().optional(),
  spentUsd: z.number().optional(),
  /** What became of its machine's jobs (see track-record.ts). */
  track: z.partialRecord(z.enum(JOB_OUTCOMES), z.number()).optional(),
});
type WorkerKeyRecord = z.infer<typeof RecordSchema>;

/** A worker key as the API shows it: never the key or its hash. */
export interface WorkerKeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  projects?: string[];
  trusted: boolean;
  budgetUsd?: number;
  spentUsd: number;
  track: TrackRecord;
}

/** What a join code gives the key it becomes, and what can be changed on a key later (`null`: remove the limit). */
export interface ScopeSettings {
  projects?: string[] | null;
  trusted?: boolean;
  budgetUsd?: number | null;
}

/** How often spending is written down (it changes with every model call). */
const SPEND_SAVE_MS = 30_000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Keys for worker machines, one per machine, instead of the Hub's own token. A key lets a machine
 * do worker work only (the worker connection, the projects' Git, which push to task branches
 * only) and can be revoked on its own. A machine gets one by redeeming a one-time join code,
 * which someone with the Hub's token created; the Hub keeps only the key's hash.
 */
export class WorkerKeys {
  private readonly codes = new Map<string, { expiresAt: number; name?: string; scope?: ScopeSettings }>();
  private spendSaveAt = 0;
  private readonly lastUsedSaved = new Map<string, number>();

  private readonly writer: JsonFileWriter | undefined;

  private constructor(
    private records: WorkerKeyRecord[],
    file?: string,
  ) {
    this.writer = file ? new JsonFileWriter(file, 0o600) : undefined;
  }

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

  /**
   * A one-time code a new machine trades for its key. `name` labels the key (default: the
   * machine's hostname); `scope` limits it (default: all projects, trusted, no budget).
   */
  createJoinCode(name?: string, now = Date.now(), scope?: ScopeSettings): { code: string; expiresAt: string } {
    for (const [code, c] of this.codes) if (c.expiresAt <= now) this.codes.delete(code);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(18).toString("base64url");
    const expiresAt = now + JOIN_CODE_TTL_MS;
    this.codes.set(code, { expiresAt, ...(name ? { name } : {}), ...(scope ? { scope } : {}) });
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
    const record: WorkerKeyRecord = applyScope(
      { id: randomUUID().slice(0, 8), name: entry.name ?? machine, hash: sha256(key), createdAt: new Date(now).toISOString() },
      entry.scope ?? {},
    );
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

  /**
   * The discovery secret of the unrevoked key, or unexpired join code, whose discovery id is
   * `keyId`: a joining machine finds the Hub with its code, a joined one with its key.
   */
  secretForKeyId(keyId: string, now = Date.now()): string | undefined {
    const record = this.records.find((r) => !r.revokedAt && discoveryKeyId(r.hash) === keyId);
    if (record) return record.hash;
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) continue;
      const secret = discoverySecret(code);
      if (discoveryKeyId(secret) === keyId) return secret;
    }
    return undefined;
  }

  /** A key's scope, for the rules in worker-scope.ts; undefined for no such key. */
  scopeOf(id: string): KeyScope | undefined {
    const r = this.records.find((x) => x.id === id);
    return r && { ...(r.projects ? { projects: r.projects } : {}), trusted: r.trusted ?? true, ...(r.budgetUsd !== undefined ? { budgetUsd: r.budgetUsd } : {}), spentUsd: r.spentUsd ?? 0 };
  }

  /** Change a key's scope; returns it, or undefined when there is no such key. */
  async setScope(id: string, changes: ScopeSettings): Promise<WorkerKeyView | undefined> {
    const record = this.records.find((r) => r.id === id);
    if (!record) return undefined;
    applyScope(record, changes);
    await this.save();
    log.info(`worker key ${record.id} (${record.name}): ${describeScope(this.scopeOf(id)!)}`);
    return view(record);
  }

  /** Count what became of a job its machine took (saved in the background). */
  recordOutcome(id: string, outcome: JobOutcome): void {
    const record = this.records.find((r) => r.id === id);
    if (!record) return;
    record.track = addOutcome(record.track, outcome);
    this.save().catch((err: Error) => log.warn(`could not save worker key ${id}'s track record: ${err.message}`));
  }

  /** Write down spending not saved yet (the Hub calls this when it stops). */
  async flush(): Promise<void> {
    await this.save();
  }

  /**
   * Add model spending caused by a key's jobs; written down every half minute at most. The budget
   * is checked before a call and spending added after it, so calls at once can overshoot a little:
   * it is an estimate.
   */
  addSpend(id: string, usd: number, now = Date.now()): void {
    const record = this.records.find((r) => r.id === id);
    if (!record || usd <= 0) return;
    record.spentUsd = Math.round(((record.spentUsd ?? 0) + usd) * 1e6) / 1e6;
    if (now - this.spendSaveAt < SPEND_SAVE_MS) return;
    this.spendSaveAt = now;
    this.save().catch((err: Error) => log.warn(`could not save worker key spending: ${err.message}`));
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
   * Write the keys (owner-only). Unlike other state, a failure is thrown: a join that wasn't
   * saved would lose its key, and a revocation that wasn't saved would let the key back in after
   * a restart.
   */
  private save(): Promise<void> {
    return this.writer ? this.writer.save(this.records) : Promise.resolve();
  }
}

function view({ hash: _hash, trusted, spentUsd, track, ...rest }: WorkerKeyRecord): WorkerKeyView {
  return { ...rest, trusted: trusted ?? true, spentUsd: spentUsd ?? 0, track: track ?? {} };
}

/** Set a record's scope fields from settings (`null` removes a limit; absent leaves it). */
function applyScope(record: WorkerKeyRecord, s: ScopeSettings): WorkerKeyRecord {
  if (s.projects === null) delete record.projects;
  else if (s.projects) record.projects = [...new Set(s.projects)];
  if (s.trusted !== undefined) record.trusted = s.trusted;
  if (s.budgetUsd === null) delete record.budgetUsd;
  else if (s.budgetUsd !== undefined) record.budgetUsd = s.budgetUsd;
  return record;
}
