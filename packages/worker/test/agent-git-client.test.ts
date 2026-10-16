import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AgentGitClient, AgentGitError, excludeLocally, ProtectedFileError, RebaseConflictError } from "@aso/worker";

process.env.ASO_LOG_LEVEL ??= "warn";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Hub",
  GIT_AUTHOR_EMAIL: "hub@test",
  GIT_COMMITTER_NAME: "Hub",
  GIT_COMMITTER_EMAIL: "hub@test",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function write(dir: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

let root: string;
let origin: string;
let hubClone: string;
let client: AgentGitClient;

/** Simulates the Hub committing directly to main (e.g. a dependency install). */
function hubCommit(file: string, content: string): string {
  git(hubClone, "pull", "--quiet", "origin", "main");
  write(hubClone, file, content);
  git(hubClone, "add", "-A");
  git(hubClone, "commit", "--quiet", "-m", `hub: ${file}`);
  git(hubClone, "push", "--quiet", "origin", "main");
  return git(hubClone, "rev-parse", "HEAD");
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "aso-git-"));
  origin = path.join(root, "origin.git");
  hubClone = path.join(root, "hub");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, hubClone);
  git(hubClone, "checkout", "--quiet", "-b", "main");
  write(hubClone, "README.md", "hello\n");
  write(hubClone, "package.json", '{ "name": "target" }\n');
  git(hubClone, "add", "-A");
  git(hubClone, "commit", "--quiet", "-m", "init");
  git(hubClone, "push", "--quiet", "origin", "main");

  client = await AgentGitClient.cloneOrOpen(path.join(root, "worker"), origin);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("AgentGitClient", () => {
  it("never commits node_modules, even in a project without a .gitignore", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "node_modules/left-pad/index.js", "module.exports = 1;\n");
    write(client.repoDir, "src/a.ts", "export const a = 1;\n");
    const done = await client.completeTask("feat: add a");
    assert.deepEqual(done.files, ["src/a.ts"]);
    assert.equal(git(origin, "ls-tree", "-r", "--name-only", "task/feat-1").includes("node_modules"), false);
    assert.ok(existsSync(path.join(client.repoDir, "node_modules/left-pad/index.js")), "kept for the next job");

    // Opening the checkout again adds nothing twice.
    await AgentGitClient.cloneOrOpen(client.repoDir, origin);
    await excludeLocally(client.repoDir, ["node_modules/"]);
    const exclude = readFileSync(path.join(client.repoDir, ".git", "info", "exclude"), "utf8");
    assert.equal(exclude.split("\n").filter((l) => l === "node_modules/").length, 1);
  });


  it("startTask branches task/<id> from origin/main", async () => {
    const { branch, base } = await client.startTask("feat-1");
    assert.equal(branch, "task/feat-1");
    assert.equal(base, git(origin, "rev-parse", "main"));
    assert.equal(git(client.repoDir, "rev-parse", "--abbrev-ref", "HEAD"), "task/feat-1");
    assert.equal(client.currentTask, "feat-1");
  });

  it("completeTask stages, commits and pushes the task branch", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "src/a.ts", "export const a = 1;\n");
    write(client.repoDir, "README.md", "changed\n");

    const done = await client.completeTask("feat: add a");
    assert.equal(done.branch, "task/feat-1");
    assert.deepEqual(done.files, ["README.md", "src/a.ts"]);
    assert.equal(git(origin, "rev-parse", "task/feat-1"), done.commit);
    assert.equal(git(origin, "log", "-1", "--format=%s|%an", "task/feat-1"), "feat: add a|ASO Agent");
    assert.equal(client.currentTask, undefined);
  });

  it("refuses to commit package.json or lockfiles anywhere in the tree", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "src/a.ts", "x\n");
    write(client.repoDir, "packages/web/pnpm-lock.yaml", "lock\n");
    write(client.repoDir, "package.json", '{ "name": "target", "dependencies": { "x": "1" } }\n');

    await assert.rejects(client.completeTask("feat"), (err: unknown) => {
      assert.ok(err instanceof ProtectedFileError);
      assert.deepEqual(err.files, ["package.json", "packages/web/pnpm-lock.yaml"]);
      return true;
    });
    assert.throws(() => git(origin, "rev-parse", "--verify", "--quiet", "task/feat-1"));
  });

  it("refuses when there is nothing to commit", async () => {
    await client.startTask("feat-1");
    await assert.rejects(client.completeTask("noop"), AgentGitError);
  });

  it("rejects empty commit messages and calls without an active task", async () => {
    await assert.rejects(client.completeTask("msg"), /no active task/);
    await client.startTask("feat-1");
    write(client.repoDir, "a.txt", "a\n");
    await assert.rejects(client.completeTask("   "), /must not be empty/);
  });

  it("rejects invalid task ids and dirty working trees on startTask", async () => {
    await assert.rejects(client.startTask("../main"));
    write(client.repoDir, "stray.txt", "x\n");
    await assert.rejects(client.startTask("feat-1"), /uncommitted changes/);
  });

  it("detects HEAD being moved off the task branch", async () => {
    await client.startTask("feat-1");
    git(client.repoDir, "checkout", "--quiet", "main");
    await assert.rejects(client.completeTask("x"), /expected to be on task\/feat-1/);
  });

  it("startTask resumes an existing remote task branch", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "a.txt", "v1\n");
    const first = await client.completeTask("v1");

    const { base } = await client.startTask("feat-1");
    assert.equal(base, first.commit);
    write(client.repoDir, "a.txt", "v2\n");
    const second = await client.completeTask("v2");
    assert.equal(git(origin, "rev-parse", "task/feat-1~1"), first.commit);
    assert.equal(git(origin, "rev-parse", "task/feat-1"), second.commit);
  });

  it("syncWithMain rebases onto new main while keeping uncommitted edits", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "src/a.ts", "work in progress\n");
    write(client.repoDir, "README.md", "local edit\n");

    const mainHead = hubCommit("package-lock.json", "{}\n");
    await client.syncWithMain();

    assert.equal(git(client.repoDir, "rev-parse", "HEAD"), mainHead);
    assert.ok(existsSync(path.join(client.repoDir, "package-lock.json")));
    assert.equal(readFileSync(path.join(client.repoDir, "src/a.ts"), "utf8"), "work in progress\n");
    assert.equal(readFileSync(path.join(client.repoDir, "README.md"), "utf8"), "local edit\n");
    assert.equal(git(client.repoDir, "stash", "list"), "");

    // The lockfile came from main, so it does not count against the task branch.
    const done = await client.completeTask("feat: a");
    assert.deepEqual(done.files, ["README.md", "src/a.ts"]);
  });

  it("syncWithMain can push after rewriting an already-pushed branch", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "a.txt", "v1\n");
    await client.completeTask("v1");
    await client.startTask("feat-1");
    hubCommit("dep.txt", "dep\n");

    await client.syncWithMain();
    write(client.repoDir, "a.txt", "v2\n");
    const done = await client.completeTask("v2");
    assert.equal(git(origin, "rev-parse", "task/feat-1"), done.commit);
    assert.equal(git(origin, "rev-parse", "task/feat-1~2"), git(origin, "rev-parse", "main"));
  });

  it("syncWithMain aborts a conflicting rebase and leaves the branch unchanged", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "README.md", "task version\n");
    await client.completeTask("task edit");
    await client.startTask("feat-1");
    const before = git(client.repoDir, "rev-parse", "HEAD");
    hubCommit("README.md", "main version\n");

    await assert.rejects(client.syncWithMain(), (err: unknown) => {
      assert.ok(err instanceof RebaseConflictError);
      assert.equal(err.stage, "rebase");
      assert.deepEqual(err.files, ["README.md"]);
      return true;
    });
    assert.equal(git(client.repoDir, "rev-parse", "HEAD"), before);
    assert.equal(git(client.repoDir, "status", "--porcelain"), "");
  });

  it("syncWithMain reports conflicts when restoring uncommitted edits, keeping the stash", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "README.md", "uncommitted task edit\n");
    hubCommit("README.md", "main version\n");

    await assert.rejects(client.syncWithMain(), (err: unknown) => {
      assert.ok(err instanceof RebaseConflictError);
      assert.equal(err.stage, "restore");
      return true;
    });
    assert.match(git(client.repoDir, "stash", "list"), /aso: syncWithMain/);
  });

  it("reports whether startTask resumed an existing remote branch", async () => {
    assert.equal((await client.startTask("feat-1")).resumed, false);
    write(client.repoDir, "a.txt", "a\n");
    await client.completeTask("a");
    assert.equal((await client.startTask("feat-1")).resumed, true);
  });

  it("discardLocalChanges clears leftovers from a crashed job but keeps ignored files", async () => {
    hubCommit(".gitignore", "node_modules/\n");
    await client.startTask("feat-1");
    write(client.repoDir, "README.md", "half-done edit\n");
    write(client.repoDir, "stray/new.ts", "x\n");
    write(client.repoDir, "node_modules/dep/index.js", "cached\n");

    await client.discardLocalChanges();
    assert.equal(git(client.repoDir, "status", "--porcelain"), "");
    assert.equal(readFileSync(path.join(client.repoDir, "README.md"), "utf8"), "hello\n");
    assert.ok(existsSync(path.join(client.repoDir, "node_modules/dep/index.js")));
    assert.equal(client.currentTask, undefined);
    await client.startTask("feat-2");
  });

  it("checkoutCommit checks out a commit on the task branch for QA", async () => {
    await client.startTask("feat-1");
    write(client.repoDir, "a.txt", "a\n");
    const done = await client.completeTask("a");

    const qaDir = path.join(root, "qa");
    const qa = await AgentGitClient.cloneOrOpen(qaDir, origin);
    await qa.checkoutCommit("feat-1", done.commit);
    assert.equal(git(qaDir, "rev-parse", "HEAD"), done.commit);
    assert.equal(readFileSync(path.join(qaDir, "a.txt"), "utf8"), "a\n");

    const mainSha = git(origin, "rev-parse", "main");
    await assert.rejects(qa.checkoutCommit("feat-1", "f".repeat(40)), /is not on task\/feat-1/);
    await assert.rejects(qa.checkoutCommit("nope", mainSha), /does not exist on the Hub/);
    await assert.rejects(qa.checkoutCommit("feat-1", "not-a-sha"));
  });

  it("cloneOrOpen repoints an existing checkout when the Hub address changes", async () => {
    const moved = path.join(root, "moved.git");
    git(root, "clone", "--quiet", "--bare", origin, moved);
    const reopened = await AgentGitClient.cloneOrOpen(client.repoDir, moved);
    assert.equal(git(reopened.repoDir, "remote", "get-url", "origin"), moved);
  });
});
