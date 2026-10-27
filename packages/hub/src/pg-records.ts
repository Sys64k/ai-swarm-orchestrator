/**
 * How the Hub's records map to its database tables: the text Postgres accepts, the query
 * columns beside each record, and what changed since the last save. Pure, apart from the two
 * statements at the end.
 */

/** Anything that runs a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export type JsonObject = Record<string, unknown>;
export const asRecord = (v: unknown): JsonObject => (typeof v === "object" && v !== null ? (v as JsonObject) : {});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = new RegExp(LONE_SURROGATE.source, "g");
const REPLACEMENT_CHARACTER = String.fromCharCode(0xfffd);

/**
 * A record as JSON text the database accepts: Postgres refuses half of a UTF-16 surrogate pair
 * (which a model's output, cut mid-character, can contain), so those become U+FFFD.
 */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" && LONE_SURROGATE.test(v) ? v.replace(LONE_SURROGATES, REPLACEMENT_CHARACTER) : v));
}

/** A string for a text column (which can't hold NUL characters), or null. */
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v.replace(/\0/g, "") : null);
/** A parsable time for a timestamptz column, or null. */
const timestampOrNull = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);

/** One record to write: its id, its JSON text, and its query column values. */
export interface Row {
  id: string;
  text: string;
  values: unknown[];
}

/** How a kind of record maps to its table. */
export interface Table {
  name: "tasks" | "plans";
  idColumn: string;
  /** Its query columns, in the order `valuesOf` gives them. */
  columns: readonly string[];
  idOf(record: JsonObject): string | undefined;
  valuesOf(record: JsonObject): unknown[];
}

export const TASKS: Table = {
  name: "tasks",
  idColumn: "task_id",
  columns: ["state", "role", "title", "created_at", "updated_at", "cost_usd"],
  idOf: (t) => textOrNull(asRecord(t.spec).taskId) ?? undefined,
  valuesOf: (t) => {
    const spec = asRecord(t.spec);
    const cost = asRecord(t.llm).costUsd;
    return [textOrNull(t.state) ?? "unknown", textOrNull(spec.role), textOrNull(spec.title), timestampOrNull(t.createdAt), timestampOrNull(t.updatedAt), typeof cost === "number" && Number.isFinite(cost) ? cost : 0];
  },
};

export const PLANS: Table = {
  name: "plans",
  idColumn: "plan_id",
  columns: ["state", "created_at", "updated_at"],
  idOf: (p) => textOrNull(p.planId) ?? undefined,
  valuesOf: (p) => [textOrNull(p.state) ?? "unknown", timestampOrNull(p.createdAt), timestampOrNull(p.updatedAt)],
};

/** What changed since the last save (`saved`: id to JSON text): rows to write, ids to delete, and the new saved map. */
export function diffRecords(saved: ReadonlyMap<string, string>, records: readonly JsonObject[], table: Table): { write: Row[]; remove: string[]; next: Map<string, string> } {
  const next = new Map<string, string>();
  const write: Row[] = [];
  for (const record of records) {
    const id = table.idOf(record);
    if (id === undefined) continue;
    const text = toJsonText(record);
    next.set(id, text);
    if (saved.get(id) !== text) write.push({ id, text, values: table.valuesOf(record) });
  }
  const remove = [...saved.keys()].filter((id) => !next.has(id));
  return { write, remove, next };
}

/** Insert or update a project's rows in a table. */
export async function upsertRows(db: Queryable, table: Table, project: string, rows: readonly Row[]): Promise<void> {
  const columns = [table.idColumn, ...table.columns, "data"];
  const params = columns.map((_, i) => `$${i + 2}`).join(", ");
  const updates = [...table.columns, "data"].map((c) => `${c} = excluded.${c}`).join(", ");
  const sql = `INSERT INTO ${table.name} (project, ${columns.join(", ")}) VALUES ($1, ${params}) ON CONFLICT (project, ${table.idColumn}) DO UPDATE SET ${updates}`;
  for (const row of rows) await db.query(sql, [project, row.id, ...row.values, row.text]);
}

/** Delete a project's rows from a table by id. */
export async function removeRows(db: Queryable, table: Table, project: string, ids: readonly string[]): Promise<void> {
  if (ids.length) await db.query(`DELETE FROM ${table.name} WHERE project = $1 AND ${table.idColumn} = ANY($2)`, [project, ids]);
}
