import type pg from "pg";
import { createLogger } from "@aso/shared";

const log = createLogger("db");

/**
 * Held while migrating, so two Hubs starting on one database don't migrate at once. The number
 * is arbitrary; it only has to differ from other applications' advisory locks on that database.
 */
const MIGRATION_LOCK = 7420;

/**
 * The schema, one migration per entry: entry n is version n + 1. Applied in order at start, each
 * in its own transaction. Never change an entry once released; add a new one.
 *
 * Each record is kept whole in `data` (`json`, not `jsonb`: the text round-trips exactly, so a
 * restored agent conversation is byte-identical for the model's prompt cache). The columns next
 * to it are copies for querying. `seq` keeps the order records were first saved in.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE tasks (
     project text NOT NULL,
     task_id text NOT NULL,
     seq bigserial NOT NULL,
     state text NOT NULL,
     role text,
     title text,
     created_at timestamptz,
     updated_at timestamptz,
     cost_usd double precision NOT NULL DEFAULT 0,
     data json NOT NULL,
     PRIMARY KEY (project, task_id)
   );
   CREATE INDEX tasks_project_seq ON tasks (project, seq);
   CREATE TABLE plans (
     project text NOT NULL,
     plan_id text NOT NULL,
     seq bigserial NOT NULL,
     state text NOT NULL,
     created_at timestamptz,
     updated_at timestamptz,
     data json NOT NULL,
     PRIMARY KEY (project, plan_id)
   );
   CREATE INDEX plans_project_seq ON plans (project, seq);
   CREATE TABLE conversations (
     id text PRIMARY KEY,
     data json NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   );
   CREATE TABLE hub_values (
     key text PRIMARY KEY,
     value json NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   );`,
];

/** Apply the migrations this database doesn't have yet; refuse a schema newer than this Hub's. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await client.query<{ version: number | null }>("SELECT max(version) AS version FROM schema_migrations");
    const current = rows[0]?.version ?? 0;
    if (current > MIGRATIONS.length) throw new Error(`the database's schema (version ${current}) is newer than this Hub's (${MIGRATIONS.length}); update the Hub`);
    for (let version = current + 1; version <= MIGRATIONS.length; version++) {
      await client.query("BEGIN");
      try {
        await client.query(MIGRATIONS[version - 1]);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
        log.info(`database schema: applied version ${version}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`database migration ${version} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}
