import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Database, describeDatabaseUrl, diffRecords, MIGRATIONS, parseTotals, projectStateStore, hubStateStore, SaveScheduler, TASKS, toJsonText } from "@aso/hub";
import { tempDir } from "./helpers.ts";
import { randomBytes } from "node:crypto";
import { databaseUrl, freshDatabase, postgresSkip, sql } from "./postgres-helpers.ts";

const skip = await postgresSkip();
if (skip) console.log(`# skipping PostgreSQL tests: ${skip}`);

const task = (taskId: string, extra: Record<string, unknown> = {}) => ({
  spec: { taskId, role: "backend", title: `Task ${taskId}` },
  project: "shop",
  state: "pending",
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
  llm: { calls: 0, costUsd: 0.25 },
  ...extra,
});
const plan = (planId: string) => ({ planId, project: "shop", requirement: "r", state: "proposed", createdAt: "2026-10-27T10:00:00.000Z", updatedAt: "2026-10-27T10:00:00.000Z" });

/** A store's next write, done. */
async function save(store: ReturnType<typeof projectStateStore>, tasks: unknown[], plans: unknown[] = []) {
  store.scheduleSave(() => ({ tasks, plans }));
  await store.flush();
}

describe("database records (pure)", () => {
  it("makes JSON Postgres accepts: half a surrogate pair becomes U+FFFD; whole ones, NUL and the rest stay", () => {
    const back = (v: unknown) => JSON.parse(toJsonText(v)) as { s: string };
    assert.equal(back({ s: "cut \ud83d" }).s, "cut �");
    assert.equal(back({ s: "\udc00 low" }).s, "� low");
    assert.equal(back({ s: "ok 😀 and \u0000" }).s, "ok 😀 and \u0000");
    assert.equal(toJsonText({ b: 1, a: [2] }), '{"b":1,"a":[2]}', "the key order is kept");
  });

  it("describes a database URL without its password", () => {
    const password = randomBytes(8).toString("hex");
    const described = describeDatabaseUrl(databaseUrl({ user: "aso", password, host: "db", port: 5432, database: "aso" }));
    assert.equal(described, "db:5432/aso");
    assert.ok(!described.includes(password) && !described.includes("aso@"), "neither the password nor the user");
    assert.equal(describeDatabaseUrl("not a url"), "(an unreadable database URL)");
  });

  it("finds what changed since the last save", () => {
    const t = (id: string | undefined, state: string) => ({ spec: id === undefined ? {} : { taskId: id }, state });
    const first = diffRecords(new Map(), [t("a", "x"), t("b", "y"), t(undefined, "no id")], TASKS);
    assert.deepEqual(first.write.map((r) => r.id), ["a", "b"], "records without an id are skipped");
    assert.equal(first.write[0].values[0], "x", "with its query columns");
    const second = diffRecords(first.next, [t("a", "x"), t("c", "z")], TASKS);
    assert.deepEqual(second.write.map((r) => r.id), ["c"], "unchanged records aren't written again");
    assert.deepEqual(second.remove, ["b"]);
  });
});

describe("saved usage totals", () => {
  it("takes only usable totals", () => {
    const now = "2026-10-27T12:00:00.000Z";
    assert.deepEqual(parseTotals({ calls: 3, costUsd: 0.5, since: "2026-10-01T00:00:00.000Z" }, now), { calls: 3, costUsd: 0.5, since: "2026-10-01T00:00:00.000Z" });
    assert.deepEqual(parseTotals({ calls: 3, costUsd: 0.5 }, now), { calls: 3, costUsd: 0.5, since: now }, "no start: from now");
    assert.deepEqual(parseTotals({ calls: 3, costUsd: 0.5, since: "garbage" }, now)?.since, now);
    for (const bad of [undefined, null, "x", 3, {}, { calls: "3", costUsd: 1 }, { calls: -1, costUsd: 1 }, { calls: 1, costUsd: Number.NaN }]) {
      assert.equal(parseTotals(bad, now), undefined, JSON.stringify(bad));
    }
  });
});

describe("saving in the background", () => {
  it("batches changes, tries a failed write again, and on close tries a few times before giving up", async () => {
    const written: number[] = [];
    let failures = 0;
    const scheduler = new SaveScheduler<number>(
      async (n) => {
        if (failures > 0) {
          failures--;
          throw new Error("down");
        }
        written.push(n);
      },
      { what: "test", delayMs: 5, retryMs: 20, closeRetries: 2 },
    );
    scheduler.schedule(() => 1);
    scheduler.schedule(() => 2);
    await scheduler.flush();
    assert.deepEqual(written, [2], "batched into one write of the latest");

    failures = 1;
    scheduler.schedule(() => 3);
    await scheduler.flush();
    assert.deepEqual(written, [2], "failed");
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(written, [2, 3], "tried again later");

    failures = 2; // fails twice, then works: close keeps trying
    scheduler.schedule(() => 4);
    await scheduler.close();
    assert.deepEqual(written, [2, 3, 4], "saved while closing");
    scheduler.schedule(() => 5);
    await scheduler.flush();
    assert.deepEqual(written, [2, 3, 4], "nothing after close");
  });
});

describe("PostgreSQL store", { skip }, () => {
  it("creates its schema once, and refuses a database from a newer Hub", async () => {
    const url = await freshDatabase();
    await (await Database.connect(url)).close();
    await (await Database.connect(url)).close();
    assert.deepEqual((await sql(url, "SELECT version FROM schema_migrations ORDER BY version")).map((r) => r.version), MIGRATIONS.map((_, i) => i + 1));
    await sql(url, "INSERT INTO schema_migrations (version) VALUES (999)");
    await assert.rejects(Database.connect(url), /schema \(version 999\) is newer than this Hub's/);
  });

  it("says plainly when it can't reach the database", async () => {
    const nowhere = databaseUrl({ user: "aso", password: randomBytes(8).toString("hex"), host: "127.0.0.1", port: 1, database: "aso" });
    await assert.rejects(Database.connect(nowhere, { waitMs: 0 }), /could not reach PostgreSQL at 127\.0\.0\.1:1\/aso/);
  });

  it("keeps a project's tasks and plans in order, exactly, and writes only what changed", async () => {
    const url = await freshDatabase();
    let db = await Database.connect(url);
    let store = projectStateStore(db, "shop", tempDir());
    assert.equal(await store.load(), undefined, "nothing yet");
    const odd = task("b", { detail: "NUL \u0000 and 😀 and a cut \ud83d", z: 1, a: 2 });
    await save(store, [task("c"), odd, task("a")], [plan("p1")]);
    const [before] = await sql<{ xmin: string }>(url, "SELECT xmin::text FROM tasks WHERE task_id = 'a'");

    await save(store, [task("c"), { ...odd, state: "assigned" }, task("a")], [plan("p1")]);
    const [after] = await sql<{ xmin: string }>(url, "SELECT xmin::text FROM tasks WHERE task_id = 'a'");
    assert.equal(after.xmin, before.xmin, "an unchanged task isn't rewritten");
    const columns = await sql(url, "SELECT task_id, state, role, title, cost_usd FROM tasks WHERE task_id = 'b'");
    assert.deepEqual(columns, [{ task_id: "b", state: "assigned", role: "backend", title: "Task b", cost_usd: 0.25 }], "query columns follow the record");
    await store.close();
    await db.close();

    db = await Database.connect(url);
    store = projectStateStore(db, "shop", tempDir());
    const loaded = (await store.load<Record<string, unknown>, Record<string, unknown>>())!;
    assert.deepEqual(loaded.tasks.map((t) => (t.spec as { taskId: string }).taskId), ["c", "b", "a"], "first-saved order");
    assert.equal(JSON.stringify(loaded.tasks[1]), toJsonText({ ...odd, state: "assigned" }), "the record comes back exactly, key order too");
    assert.equal(loaded.plans.length, 1);
    assert.equal(await projectStateStore(db, "blog", tempDir()).load(), undefined, "projects are kept apart");

    await save(store, [task("c")], []);
    assert.deepEqual((await sql(url, "SELECT task_id FROM tasks")).map((r) => r.task_id), ["c"], "removed records are deleted");
    assert.equal((await sql(url, "SELECT count(*)::int AS n FROM plans"))[0].n, 0);
    await store.close();
    await db.close();
  });

  it("tries a failed save again, so no change is lost", async () => {
    const url = await freshDatabase();
    const db = await Database.connect(url);
    const store = projectStateStore(db, "shop", tempDir());
    await store.load();
    await sql(url, "ALTER TABLE tasks RENAME TO tasks_away");
    store.scheduleSave(() => ({ tasks: [task("a")], plans: [] }));
    await store.flush();
    await sql(url, "ALTER TABLE tasks_away RENAME TO tasks");
    const deadline = Date.now() + 10_000;
    while (!(await sql(url, "SELECT 1 FROM tasks WHERE task_id = 'a'")).length) {
      assert.ok(Date.now() < deadline, "saved on a later try");
      await new Promise((r) => setTimeout(r, 200));
    }
    await store.close();
    await db.close();
  });

  it("imports a project's state file once, and leaves the file as it was", async () => {
    const url = await freshDatabase();
    const legacy = tempDir();
    const file = path.join(legacy, "state.json");
    writeFileSync(file, JSON.stringify({ version: 1, savedAt: "x", tasks: [task("old-1"), task("old-2")], plans: [plan("p")] }));
    const bytes = readFileSync(file, "utf8");

    let db = await Database.connect(url);
    const loaded = await projectStateStore(db, "shop", legacy).load<Record<string, unknown>, unknown>();
    assert.deepEqual(loaded!.tasks.map((t) => (t.spec as { taskId: string }).taskId), ["old-1", "old-2"]);
    assert.equal(readFileSync(file, "utf8"), bytes, "the file is kept as a backup");
    const [marker] = await sql<{ value: { tasks: number; plans: number; from: string } }>(url, "SELECT value FROM hub_values WHERE key = 'imported:project:shop'");
    assert.deepEqual([marker.value.tasks, marker.value.plans, marker.value.from], [2, 1, legacy]);
    await db.close();

    // Imported once: tasks deleted since stay deleted, though the file is still there.
    await sql(url, "DELETE FROM tasks");
    db = await Database.connect(url);
    assert.equal((await projectStateStore(db, "shop", legacy).load<unknown, unknown>())!.tasks.length, 0);
    await db.close();
  });

  it("doesn't import a state file over a project the database already has", async () => {
    const url = await freshDatabase();
    const legacy = tempDir();
    writeFileSync(path.join(legacy, "state.json"), JSON.stringify({ version: 1, tasks: [task("from-file")], plans: [] }));
    const db = await Database.connect(url);
    const store = projectStateStore(db, "shop", tempDir());
    await store.load();
    await save(store, [task("in-db")]);
    await sql(url, "DELETE FROM hub_values"); // as if the marker were lost
    const loaded = await projectStateStore(db, "shop", legacy).load<Record<string, unknown>, unknown>();
    assert.deepEqual(loaded!.tasks.map((t) => (t.spec as { taskId: string }).taskId), ["in-db"]);
    await db.close();
  });

  it("keeps agent conversations and values, importing the conversation files once", async () => {
    const url = await freshDatabase();
    const legacy = tempDir();
    mkdirSync(path.join(legacy, "conversations"));
    writeFileSync(path.join(legacy, "conversations", "c1.json"), JSON.stringify({ id: "c1", turn: 3, messages: [{ role: "user", content: "hi \u0000" }] }));
    writeFileSync(path.join(legacy, "conversations", "broken.json"), "{");

    let db = await Database.connect(url);
    let hub = hubStateStore(db, legacy);
    assert.deepEqual(await hub.loadConversations(), [{ id: "c1", turn: 3, messages: [{ role: "user", content: "hi \u0000" }] }], "imported; the unreadable file is skipped");
    hub.saveConversation("c2", { id: "c2", turn: 0, messages: [] });
    hub.saveConversation("c1", { id: "c1", turn: 4, messages: [] });
    hub.deleteConversation("c2");
    hub.saveValue("llm-totals", { calls: 7, costUsd: 1.5, since: "2026-10-27T00:00:00.000Z" });
    await hub.close();
    await db.close();

    db = await Database.connect(url);
    hub = hubStateStore(db, legacy);
    assert.deepEqual(await hub.loadConversations(), [{ id: "c1", turn: 4, messages: [] }], "not imported again");
    assert.deepEqual(await hub.loadValue("llm-totals"), { calls: 7, costUsd: 1.5, since: "2026-10-27T00:00:00.000Z" });
    assert.equal(await hub.loadValue("nothing"), undefined);
    await hub.close();
    await db.close();
  });
});
