import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { sanitizeUrl } from "@aso/hub";
import { createMessage } from "@aso/shared";
import { git, postTask, pushTaskBranch, tempDir, waitFor, withHub, worker, writeFiles, type HubContext } from "./helpers.ts";

/** Fake implementer: push files to task/<id> and report completion (QA is off in these tests). */
async function deliver(ctx: HubContext, taskId: string, files: Record<string, string>) {
  const w = await worker(ctx.port, `dev-${taskId}`);
  await postTask(ctx.port, { taskId, role: "backend", title: `Task ${taskId}`, description: "d" });
  await w.next();
  w.send(createMessage("STATUS_UPDATE", `dev-${taskId}`, { state: "in_progress", taskId }));
  const commit = await pushTaskBranch(ctx.gitUrl, taskId, files);
  w.send(createMessage("STATUS_UPDATE", `dev-${taskId}`, { state: "completed", taskId, commit }));
  await waitFor(() => ctx.hub.tasks.get(taskId)?.state === "merged", 5000, `${taskId} merged`);
  w.ws.close();
}

/** Someone pushes to "GitHub" directly. */
function pushToOrigin(originDir: string, files: Record<string, string>, message: string): string {
  const dir = tempDir("aso-elsewhere-");
  try {
    git(dir, "clone", "--quiet", originDir, ".");
    writeFiles(dir, files);
    git(dir, "add", "-A");
    git(dir, "commit", "--quiet", "-m", message);
    git(dir, "push", "--quiet", "origin", "main");
    return git(dir, "rev-parse", "HEAD");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("pushing main to origin", () => {
  it("pushes after each merge and notes it on the task", () =>
    withHub(
      async (ctx) => {
        assert.equal(ctx.hub.sync.status().state, "idle");
        await deliver(ctx, "one", { "one.txt": "1\n" });
        await waitFor(() => ctx.hub.sync.status().lastPushedCommit, 5000, "push");
        assert.equal(git(ctx.originDir!, "rev-parse", "main"), git(ctx.repoDir, "rev-parse", "main"));
        await waitFor(() => ctx.hub.tasks.get("one")!.history.some((h) => /pushed to origin \([0-9a-f]{8}\)/.test(h.event)));
      },
      { origin: true, qa: { enabled: false } },
    ));

  it("merges commits pushed to origin by someone else, then pushes", () =>
    withHub(
      async (ctx) => {
        const theirs = pushToOrigin(ctx.originDir!, { "docs.md": "from GitHub\n" }, "docs on GitHub");
        await deliver(ctx, "two", { "two.txt": "2\n" });
        await waitFor(() => ctx.hub.sync.status().lastPushedCommit, 5000, "push");
        const main = git(ctx.repoDir, "rev-parse", "main");
        assert.equal(git(ctx.originDir!, "rev-parse", "main"), main);
        assert.equal(git(ctx.repoDir, "merge-base", "--is-ancestor", theirs, "main"), "", "their commit is in main");
        assert.equal(git(ctx.repoDir, "log", "-1", "--format=%s", "main"), "Merge origin/main into main");
        assert.equal(git(ctx.repoDir, "status", "--porcelain"), "");
      },
      { origin: true, qa: { enabled: false } },
    ));

  it("stops on a conflict with origin and leaves both sides untouched", () =>
    withHub(
      async (ctx) => {
        const theirs = pushToOrigin(ctx.originDir!, { "README.md": "edited on GitHub\n" }, "edit README on GitHub");
        await deliver(ctx, "three", { "README.md": "edited by an agent\n" });
        const status = await waitFor(() => ctx.hub.sync.status().state === "conflict" && ctx.hub.sync.status(), 5000, "conflict");
        assert.match(status.lastError!, /conflicts with main in README.md/);
        assert.equal(git(ctx.originDir!, "rev-parse", "main"), theirs, "origin unchanged");
        assert.equal(git(ctx.repoDir, "show", "main:README.md"), "edited by an agent");
        assert.equal(git(ctx.repoDir, "status", "--porcelain"), "", "aborted merge left the checkout clean");
        await waitFor(() => ctx.hub.tasks.get("three")!.history.some((h) => /push to origin failed: .*conflicts/.test(h.event)));
      },
      { origin: true, qa: { enabled: false } },
    ));

  it("is disabled without an origin remote or with push turned off", async () => {
    await withHub(async (ctx) => {
      const s = ctx.hub.sync.status();
      assert.equal(s.state, "disabled");
      assert.match(s.reason!, /no "origin" remote/);
      await deliver(ctx, "local", { "l.txt": "x\n" });
      assert.equal(ctx.hub.sync.status().state, "disabled");
    }, { qa: { enabled: false } });
    await withHub(async (ctx) => {
      assert.match(ctx.hub.sync.status().reason!, /--no-push/);
      const before = git(ctx.originDir!, "rev-parse", "main");
      await deliver(ctx, "nopush", { "n.txt": "x\n" });
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(git(ctx.originDir!, "rev-parse", "main"), before);
    }, { origin: true, qa: { enabled: false }, sync: { enabled: false } });
  });

  it("catches up with a pull request merged on origin by fast forward", () =>
    withHub(
      async (ctx) => {
        const theirs = pushToOrigin(ctx.originDir!, { "merged.md": "merged on GitHub\n" }, "merge a pull request");
        assert.deepEqual(await ctx.hub.sync.catchUp(), { ok: true });
        assert.equal(git(ctx.repoDir, "rev-parse", "main"), theirs);
      },
      { origin: true, qa: { enabled: false } },
    ));

  it("catches up by merging when main has a commit origin lacks", () =>
    withHub(
      async (ctx) => {
        // The Hub committed to main (e.g. a package script change) before a pull request was merged on origin.
        writeFiles(ctx.repoDir, { "scripts.txt": "hub's own\n" });
        git(ctx.repoDir, "add", "-A");
        git(ctx.repoDir, "commit", "--quiet", "-m", "hub's own commit");
        const ours = git(ctx.repoDir, "rev-parse", "main");
        const theirs = pushToOrigin(ctx.originDir!, { "merged.md": "merged on GitHub\n" }, "merge a pull request");
        assert.deepEqual(await ctx.hub.sync.catchUp(), { ok: true });
        assert.equal(git(ctx.repoDir, "merge-base", "--is-ancestor", ours, "main"), "", "our commit is in main");
        assert.equal(git(ctx.repoDir, "merge-base", "--is-ancestor", theirs, "main"), "", "their commit is in main");
        assert.equal(git(ctx.repoDir, "log", "-1", "--format=%s", "main"), "Merge origin/main into main");
        await waitFor(() => git(ctx.originDir!, "rev-parse", "main") === git(ctx.repoDir, "rev-parse", "main"), 5000, "push");
      },
      { origin: true, qa: { enabled: false } },
    ));

  it("never shows credentials from remote URLs", () => {
    assert.equal(sanitizeUrl("https://user:ghp_secret@github.com/me/app.git"), "https://github.com/me/app.git");
    assert.equal(sanitizeUrl("https://x-access-token:abc@github.com/me/app.git"), "https://github.com/me/app.git");
    assert.equal(sanitizeUrl("git@github.com:me/app.git"), "git@github.com:me/app.git");
  });
});
