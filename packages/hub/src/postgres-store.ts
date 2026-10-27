import pg from "pg";
import { createLogger } from "@aso/shared";
import { migrate } from "./db-migrations.js";
import { asRecord, diffRecords, PLANS, removeRows, TASKS, toJsonText, upsertRows, type JsonObject, type Queryable, type Table } from "./pg-records.js";
import { SaveScheduler } from "./save-scheduler.js";
import { StateStore, type HubStateStore, type ProjectStateStore, type Snapshot } from "./state-store.js";

const log = createLogger("db");

/** How long to wait for the database at start (a container may still be starting). */
const CONNECT_WAIT_MS = 60_000;

const UPSERT_CONVERSATION =
  "INSERT INTO conversations (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = now()";
const UPSERT_VALUE = "INSERT INTO hub_values (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()";

const setValue = (db: Queryable, key: string, value: unknown) => db.query(UPSERT_VALUE, [key, toJsonText(value)]);

/** A database URL without its user and password, for logs. */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(an unreadable database URL)";
  }
}

/**
 * The Hub's PostgreSQL database: tasks, plans, agent conversations and named values. Settings
 * and keys stay in files (`<projectsRoot>/.aso/`); transcripts and screenshots stay in each
 * project's `.git/aso/`.
 */
export class Database {
  private constructor(
    private readonly pool: pg.Pool,
    /** Where it is, for people and logs (no password). */
    readonly location: string,
  ) {}

  /** Connect (waiting up to a minute for the database to come up) and bring the schema up to date. */
  static async connect(url: string, opts: { waitMs?: number } = {}): Promise<Database> {
    const location = `PostgreSQL at ${describeDatabaseUrl(url)}`;
    const pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5_000 });
    // An idle connection that breaks (a database restart) must not take the Hub down.
    pool.on("error", (err) => log.warn(`database connection lost: ${err.message}`));
    const deadline = Date.now() + (opts.waitMs ?? CONNECT_WAIT_MS);
    for (let attempt = 1; ; attempt++) {
      try {
        await pool.query("SELECT 1");
        break;
      } catch (err) {
        if (Date.now() >= deadline) {
          await pool.end().catch(() => undefined);
          throw new Error(`could not reach ${location}: ${(err as Error).message}`);
        }
        if (attempt === 1) log.info(`waiting for ${location} (${(err as Error).message})`);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    await migrate(pool);
    log.info(`state in ${location}`);
    return new Database(pool, location);
  }

  /** @internal For the stores. */
  query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
    return this.pool.query<T>(sql, params);
  }

  /** @internal Run `fn` in one transaction. */
  async transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** A project's tasks and plans: in the database when there is one, else in its state file. */
export function projectStateStore(database: Database | undefined, project: string, stateDir: string): ProjectStateStore {
  return database ? new PgProjectStore(database, project, stateDir) : new StateStore(stateDir);
}

/** Conversations and values: in the database when there is one, else in files in `dir`. */
export function hubStateStore(database: Database | undefined, dir: string): HubStateStore {
  return database ? new PgHubStore(database, dir) : new StateStore(dir);
}

/** What an import copies: written in the same transaction as its marker. */
interface Import {
  summary: JsonObject;
  write(db: Queryable): Promise<void>;
}

/**
 * Run an import once per `marker`: what it copies and the marker go in one transaction, so a
 * crash in between leaves neither and the next start tries again. Returns its summary when it
 * copied something.
 */
async function importOnce(db: Database, marker: string, find: () => Promise<Import | undefined>): Promise<JsonObject | undefined> {
  if ((await db.query("SELECT 1 FROM hub_values WHERE key = $1", [marker])).rowCount) return undefined;
  const found = await find();
  await db.transaction(async (client) => {
    await found?.write(client);
    await setValue(client, marker, { at: new Date().toISOString(), ...(found?.summary ?? { nothing: true }) });
  });
  return found?.summary;
}

const recordsOf = (snapshot: Snapshot<unknown, unknown>, table: Table) => (table === TASKS ? snapshot.tasks : snapshot.plans) as JsonObject[];

class PgProjectStore implements ProjectStateStore {
  /** Per table: each record's JSON text as last saved, so only changed records are written. */
  private readonly saved = new Map<Table, Map<string, string>>([
    [TASKS, new Map()],
    [PLANS, new Map()],
  ]);
  private readonly saves: SaveScheduler<Snapshot<unknown, unknown>>;

  constructor(
    private readonly db: Database,
    private readonly project: string,
    /** The project's old state folder, imported once. */
    private readonly stateDir: string,
  ) {
    this.saves = new SaveScheduler((snapshot) => this.write(snapshot), { what: `project ${project}'s state` });
  }

  get location(): string {
    return `${this.db.location} (project ${this.project})`;
  }

  async load<T, P>(): Promise<Snapshot<T, P> | undefined> {
    await this.importStateFile();
    const read = async (table: Table) => {
      const { rows } = await this.db.query<{ id: string; data: unknown }>(`SELECT ${table.idColumn} AS id, data FROM ${table.name} WHERE project = $1 ORDER BY seq`, [this.project]);
      this.saved.set(table, new Map(rows.map((r) => [r.id, toJsonText(r.data)])));
      return rows.map((r) => r.data);
    };
    const snapshot = { tasks: (await read(TASKS)) as T[], plans: (await read(PLANS)) as P[] };
    return snapshot.tasks.length || snapshot.plans.length ? snapshot : undefined;
  }

  /** The project's state file, copied in once (and left in place, as a backup). */
  private async importStateFile(): Promise<void> {
    const imported = await importOnce(this.db, `imported:project:${this.project}`, async () => {
      if (await this.hasRows()) return undefined;
      const saved = await new StateStore(this.stateDir).load<JsonObject, JsonObject>();
      if (!saved) return undefined;
      return {
        summary: { from: this.stateDir, tasks: saved.tasks.length, plans: saved.plans.length },
        write: async (db) => {
          for (const table of [TASKS, PLANS]) await upsertRows(db, table, this.project, diffRecords(new Map(), recordsOf(saved, table), table).write);
        },
      };
    });
    if (imported) log.info(`project ${this.project}: imported ${String(imported.tasks)} task(s) and ${String(imported.plans)} plan(s) from ${this.stateDir}/state.json (the file is kept as a backup)`);
  }

  private async hasRows(): Promise<boolean> {
    const { rowCount } = await this.db.query("SELECT 1 FROM tasks WHERE project = $1 UNION ALL SELECT 1 FROM plans WHERE project = $1 LIMIT 1", [this.project]);
    return !!rowCount;
  }

  scheduleSave(snapshot: () => Snapshot<unknown, unknown>): void {
    this.saves.schedule(snapshot);
  }

  flush(): Promise<unknown> {
    return this.saves.flush();
  }

  close(): Promise<void> {
    return this.saves.close();
  }

  /** Write what changed since the last successful save, in one transaction. */
  private async write(snapshot: Snapshot<unknown, unknown>): Promise<void> {
    const changes = [TASKS, PLANS].map((table) => ({ table, ...diffRecords(this.saved.get(table)!, recordsOf(snapshot, table), table) }));
    if (changes.every((c) => !c.write.length && !c.remove.length)) return;
    await this.db.transaction(async (db) => {
      for (const c of changes) {
        await upsertRows(db, c.table, this.project, c.write);
        await removeRows(db, c.table, this.project, c.remove);
      }
    });
    for (const c of changes) this.saved.set(c.table, c.next);
  }
}

class PgHubStore implements HubStateStore {
  /** Writes in order, one at a time; a failure is logged (the next turn's save replaces it). */
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly db: Database,
    /** The old folder of conversation files, imported once. */
    private readonly dir: string,
  ) {}

  private enqueue(what: string, fn: () => Promise<unknown>): void {
    if (this.closed) return;
    this.writes = this.writes.then(fn).catch((err: Error) => log.error(`saving ${what} failed: ${err.message}`));
  }

  saveConversation(id: string, data: unknown): void {
    const text = toJsonText(data);
    this.enqueue(`conversation ${id}`, () => this.db.query(UPSERT_CONVERSATION, [id, text]));
  }

  deleteConversation(id: string): void {
    this.enqueue(`conversation ${id}`, () => this.db.query("DELETE FROM conversations WHERE id = $1", [id]));
  }

  async loadConversations<C>(): Promise<C[]> {
    await this.importConversationFiles();
    const { rows } = await this.db.query<{ data: C }>("SELECT data FROM conversations ORDER BY updated_at, id");
    return rows.map((r) => r.data);
  }

  /** The conversation files, copied in once (and left in place, as a backup). */
  private async importConversationFiles(): Promise<void> {
    const imported = await importOnce(this.db, "imported:conversations", async () => {
      const saved = (await new StateStore(this.dir).loadConversations<JsonObject>()).filter((c) => typeof asRecord(c).id === "string");
      if (!saved.length) return undefined;
      return {
        summary: { from: this.dir, conversations: saved.length },
        write: async (db) => {
          for (const c of saved) await db.query(UPSERT_CONVERSATION, [c.id, toJsonText(c)]);
        },
      };
    });
    if (imported) log.info(`imported ${String(imported.conversations)} agent conversation(s) from ${this.dir}/conversations (the files are kept as a backup)`);
  }

  saveValue(key: string, value: unknown): void {
    this.enqueue(`value ${key}`, () => setValue(this.db, key, value));
  }

  async loadValue<V>(key: string): Promise<V | undefined> {
    const { rows } = await this.db.query<{ value: V }>("SELECT value FROM hub_values WHERE key = $1", [key]);
    return rows[0]?.value;
  }

  async close(): Promise<void> {
    await this.writes;
    this.closed = true;
  }
}
