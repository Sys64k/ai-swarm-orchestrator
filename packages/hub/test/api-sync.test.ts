import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { API_DOC_VERSION, apiChanges, apiFileContents, apiHash, openApiDocument, syncApiCopies, syncTaskId, syncTaskSpec } from "@aso/hub";
import { git, tempDir, TOKEN, waitFor, withHub, writeFiles } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const current = () => openApiDocument(API_DOC_VERSION) as unknown as { info: { title: string }; paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, unknown> } };

/** The Hub's description as an older Hub had it: one route missing, one schema different. */
function olderDescription() {
  const doc = structuredClone(current());
  delete doc.paths["/api/hub/update"];
  doc.components.schemas.Version = { type: "object" };
  return doc;
}

const syncTask = (tasks: Array<{ spec: { taskId: string } }>) => tasks.find((t) => t.spec.taskId.startsWith("sync-hub-api-"));

describe("syncing a project's copy of the Hub API description", () => {
  it("names what changed between two descriptions", () => {
    const before = { paths: { "/a": { get: { x: 1 }, post: { x: 1 } }, "/gone": { get: {} } }, components: { schemas: { A: { type: "string" }, Old: {} } } };
    const after = { paths: { "/a": { get: { x: 2 }, post: { x: 1 } }, "/new": { put: {} } }, components: { schemas: { A: { type: "string" }, New: {} } } };
    assert.deepEqual(apiChanges(before, after), { added: ["PUT /new", "schema New"], removed: ["GET /gone", "schema Old"], changed: ["GET /a"] });
  });

  it("names a description by its content, not its key order, and gives each project its own task", () => {
    assert.equal(apiHash({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } }), apiHash({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }));
    assert.notEqual(apiHash({ a: 1 }), apiHash({ a: 2 }));
    assert.notEqual(syncTaskId("shop", "h"), syncTaskId("blog", "h"));
    assert.match(syncTaskId("shop", "h"), /^sync-hub-api-[0-9a-f]{12}$/);
  });

  it("asks for regenerating and fixing, not for features, and keeps long lists short", () => {
    const spec = syncTaskSpec("sync-hub-api-abc", "0.1.0", { added: Array.from({ length: 45 }, (_, i) => `GET /r${i}`), removed: [], changed: ["schema Task"] });
    assert.equal(spec.role, "frontend");
    assert.match(spec.description, /branch already has the new copy \(Hub API 0\.1\.0\) as its first commit/);
    assert.match(spec.description, /- Added: GET \/r0, .*GET \/r39, and 5 more/);
    assert.match(spec.description, /- Changed: schema Task/);
    assert.match(spec.description, /don't build features on new endpoints/);
    assert.doesNotMatch(spec.description, /Removed:/);
    assert.deepEqual(spec.files, ["docs/openapi.json"]);
  });

  it("puts the new description on a task branch and queues the task, once", () =>
    withHub(
      async (ctx) => {
        const mainBefore = git(ctx.repoDir, "rev-parse", "main");
        const task = await waitFor(() => syncTask(ctx.hub.tasks.list()), 10_000, "a sync task");
        assert.equal(task.state, "pending");
        assert.equal(task.spec.title, "Sync the Hub API description");
        assert.match(task.spec.description, /- Added: POST \/api\/hub\/update, GET \/api\/hub\/update|- Added: GET \/api\/hub\/update, POST \/api\/hub\/update/);
        assert.match(task.spec.description, /- Changed: .*schema Version/);

        const branch = `task/${task.spec.taskId}`;
        assert.equal(git(ctx.repoDir, "show", `${branch}:docs/openapi.json`) + "\n", apiFileContents(current()), "the branch has the Hub's description");
        assert.equal(git(ctx.repoDir, "rev-parse", `${branch}^`), mainBefore, "one commit on top of main");
        assert.equal(git(ctx.repoDir, "log", "-1", "--format=%an|%s", branch), `ASO Hub|chore: sync the Hub API description (${API_DOC_VERSION})`);
        assert.equal(git(ctx.repoDir, "rev-parse", "main"), mainBefore, "main untouched");
        assert.equal(task.diffBase, git(ctx.repoDir, "rev-parse", branch), "its acceptance check starts after the Hub's own commit");
        assert.match(task.spec.acceptanceCriteria[0], /isn't changed in the diff \(the Hub's own first commit on this branch put the new copy there, and the diff starts after it\)/);

        // The diff the acceptance check reads: an agent's work on top, without the Hub's copy.
        const work = tempDir();
        git(work, "clone", "--quiet", ctx.repoDir, ".");
        git(work, "checkout", "--quiet", branch);
        writeFiles(work, { "src/generated.ts": "export {};\n" });
        git(work, "add", "-A");
        git(work, "-c", "user.name=a", "-c", "user.email=a@x", "commit", "--quiet", "-m", "regenerate");
        git(work, "push", "--quiet", "origin", branch);
        const head = git(ctx.repoDir, "rev-parse", branch);
        const project = ctx.hub.projects.list()[0];
        const fromSeed = await project.repo.diff(head, task.diffBase);
        assert.deepEqual(fromSeed?.files.map((f) => f.path), ["src/generated.ts"], "only the agent's work");
        const fromMain = await project.repo.diff(head);
        assert.deepEqual(fromMain?.files.map((f) => f.path).sort(), ["docs/openapi.json", "src/generated.ts"], "the pull request still shows both");
        assert.equal((await project.repo.diff(head, "0".repeat(40)))?.base, mainBefore, "a base that isn't on the branch falls back to main");
        assert.equal(git(ctx.repoDir, "status", "--porcelain"), "", "the checkout untouched");

        await syncApiCopies(ctx.hub.projects.list(), current());
        assert.equal(ctx.hub.tasks.list().filter((t) => t.spec.taskId.startsWith("sync-hub-api-")).length, 1, "not queued twice");
      },
      { files: { "docs/openapi.json": apiFileContents(olderDescription()) } },
    ));

  it("replaces older syncs of a project with a newer one, which nobody can retry", () =>
    withHub(
      async (ctx) => {
        const first = await waitFor(() => syncTask(ctx.hub.tasks.list()), 10_000, "a sync task");
        // The Hub's API changes again before the first sync is done.
        const newer = { ...current(), info: { ...current().info, description: "a newer version" } };
        await syncApiCopies(ctx.hub.projects.list(), newer as never);
        const syncs = ctx.hub.tasks.list().filter((t) => t.spec.taskId.startsWith("sync-hub-api-"));
        assert.equal(syncs.length, 2);
        const second = syncs.find((t) => t.spec.taskId !== first.spec.taskId)!;
        const old = ctx.hub.tasks.get(first.spec.taskId)!;
        assert.equal(old.state, "cancelled", "the older one stops");
        assert.equal(old.supersededBy, second.spec.taskId);
        assert.ok(old.history.some((h) => h.event === `superseded by ${second.spec.taskId}, which does its job`));
        assert.equal(second.state, "pending", "the newer one goes on");

        const retried = await fetch(`http://127.0.0.1:${ctx.port}/api/tasks/${first.spec.taskId}/retry`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
        assert.equal(retried.status, 409);
        assert.match(((await retried.json()) as { error: string }).error, /superseded by sync-hub-api-.*nothing to retry/);
      },
      { files: { "docs/openapi.json": apiFileContents(olderDescription()) } },
    ));

  it("leaves a project alone whose copy is current, is another API's, or isn't JSON, or that has none", async () => {
    for (const files of [
      { "docs/openapi.json": apiFileContents(current()) },
      { "docs/openapi.json": JSON.stringify({ ...olderDescription(), info: { title: "Some other API", version: "1" } }) },
      { "docs/openapi.json": "{ not json" },
      { "docs/openapi.json": "null" },
      { "docs/openapi.json": JSON.stringify(Object.fromEntries(Object.entries(current()).reverse())) }, // the same, keys in another order
      {},
    ]) {
      await withHub(
        async (ctx) => {
          await syncApiCopies(ctx.hub.projects.list(), current());
          await new Promise((r) => setTimeout(r, 200)); // the one at start, too
          assert.equal(syncTask(ctx.hub.tasks.list()), undefined, JSON.stringify(Object.keys(files)));
          assert.equal(git(ctx.repoDir, "branch", "--list", "task/*"), "");
        },
        { files },
      );
    }
  });

  it("can be turned off", () =>
    withHub(
      async (ctx) => {
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(syncTask(ctx.hub.tasks.list()), undefined);
      },
      { files: { "docs/openapi.json": apiFileContents(olderDescription()) }, apiSync: false },
    ));
});
