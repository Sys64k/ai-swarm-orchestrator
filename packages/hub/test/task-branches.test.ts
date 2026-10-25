import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { mergedTaskBranches, startHub } from "@aso/hub";
import { git, makeTargetRepo, TOKEN, waitFor, writeFiles } from "./helpers.ts";

describe("task branches", () => {
  it("picks merged tasks' branches, and unowned ones already in main", () => {
    const branches = new Map([
      ["merged", "c1"],
      ["failed", "c2"],
      ["running", "c3"],
      ["orphan-in-main", "c4"],
      ["orphan-elsewhere", "c5"],
    ]);
    const states: Record<string, string> = { merged: "merged", failed: "failed", running: "in_progress" };
    assert.deepEqual(mergedTaskBranches(branches, (id) => states[id], new Set(["c4", "c2"])), ["merged", "orphan-in-main"]);
  });

  it("cleans up branches already merged into main when the Hub starts, and keeps the rest", async () => {
    const repoDir = makeTargetRepo();
    // Merged before the Hub deleted branches on merge.
    git(repoDir, "checkout", "--quiet", "-b", "task/old-merged");
    writeFiles(repoDir, { "a.txt": "a\n" });
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "--quiet", "-m", "a");
    git(repoDir, "checkout", "--quiet", "main");
    git(repoDir, "merge", "--quiet", "--no-ff", "-m", "merge a", "task/old-merged");
    // Work that never reached main: kept.
    git(repoDir, "checkout", "--quiet", "-b", "task/unmerged");
    writeFiles(repoDir, { "b.txt": "b\n" });
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "--quiet", "-m", "b");
    git(repoDir, "checkout", "--quiet", "main");

    const hub = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", token: TOKEN });
    try {
      await waitFor(() => git(repoDir, "branch", "--list", "task/old-merged") === "" || undefined);
      assert.match(git(repoDir, "branch", "--list", "task/unmerged"), /task\/unmerged/);
      assert.equal(git(repoDir, "show", "main:a.txt"), "a", "main keeps the merged work");
    } finally {
      await hub.close();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
