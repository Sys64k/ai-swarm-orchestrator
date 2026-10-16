import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { HubRepository, npmInstaller, type DependencyInstaller } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import { DependencyRejectedError, startWorker, type TaskExecutor } from "@aso/worker";
import {
  git,
  hardware,
  makeTargetRepo,
  postTask,
  tempDir,
  waitFor,
  withHub,
  worker,
  writeFiles,
  type HubContext,
  type TestClient,
} from "./helpers.ts";
import { TOKEN } from "./helpers.ts";

const PKG = JSON.stringify({ name: "target", version: "1.0.0" }, null, 2) + "\n";
const LOCK = (deps: Record<string, string> = {}) =>
  JSON.stringify(
    { name: "target", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "target", version: "1.0.0", ...deps } } },
    null,
    2,
  ) + "\n";

/**
 * Offline stand-in for npm: records the request in package.json under a custom key and
 * writes a valid lockfile with no packages, so a real `npm ci` on workers succeeds offline.
 */
function fakeInstaller(log: string[] = []): DependencyInstaller {
  return {
    async install(dir, packages) {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      for (const req of packages) {
        log.push(`${req.name}@${req.version ?? "latest"}${req.dev ? ":dev" : ""}`);
        const key = req.dev ? "asoTestDevDependencies" : "asoTestDependencies";
        pkg[key] = { ...pkg[key], [req.name]: req.version ?? "^1.0.0" };
      }
      writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
      writeFileSync(path.join(dir, "package-lock.json"), LOCK());
    },
  };
}

const NPM_PROJECT = { "package.json": PKG, "package-lock.json": LOCK() };

function response(m: AgentMessage) {
  assert.equal(m.type, "DEPENDENCY_RESPONSE");
  return m.type === "DEPENDENCY_RESPONSE" ? m.payload : assert.fail();
}

/** Register a fake implementer and move it to in_progress on `taskId`. */
async function implementer(ctx: HubContext, nodeId: string, taskId: string): Promise<TestClient> {
  const w = await worker(ctx.port, nodeId);
  await postTask(ctx.port, { taskId, role: "backend", title: "t", description: "d" });
  const m = await w.next();
  assert.equal(m.type, "TASK_ASSIGNMENT");
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "in_progress", taskId }));
  await waitFor(() => ctx.hub.tasks.get(taskId)?.state === "in_progress");
  return w;
}

/** One package (left-pad unless `extra` names another); `packages` sends a whole list. */
const request = (nodeId: string, taskId: string, extra: Record<string, unknown> = {}, packages?: Record<string, unknown>[]) =>
  createMessage("DEPENDENCY_REQUEST", nodeId, {
    requestId: crypto.randomUUID(),
    taskId,
    change: { type: "add_dependencies", packages: packages ?? [{ name: "left-pad", ...extra }] },
  } as never);

const scriptsRequest = (nodeId: string, taskId: string, scripts: Record<string, string>) =>
  createMessage("DEPENDENCY_REQUEST", nodeId, {
    requestId: crypto.randomUUID(),
    taskId,
    change: { type: "set_scripts", scripts },
  } as never);

describe("dependency requests (Hub)", () => {
  it("adds the package on main and answers with the new main commit", () => {
    const calls: string[] = [];
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        const before = git(ctx.repoDir, "rev-parse", "main");
        w.send(request("dev", "feat", { version: "^1.3.0", dev: true }));

        const r = response(await w.next());
        assert.equal(r.outcome, "installed");
        const main = git(ctx.repoDir, "rev-parse", "main");
        assert.ok(r.outcome === "installed" && r.mainCommit === main);
        assert.notEqual(main, before);
        assert.deepEqual(calls, ["left-pad@^1.3.0:dev"]);
        assert.equal(git(ctx.repoDir, "log", "-1", "--format=%s|%an", "main"), "chore(deps): add left-pad@^1.3.0 (dev)|ASO Hub");
        // The fake installer leaves the lockfile unchanged; the real-npm test covers both files.
        assert.equal(git(ctx.repoDir, "show", "--name-only", "--format=", "main"), "package.json");
        assert.equal(git(ctx.repoDir, "status", "--porcelain"), "");
        assert.ok(ctx.hub.tasks.get("feat")!.history.some((h) => /package change left-pad@\^1.3.0 \(dev\) committed on main/.test(h.event)));
        w.ws.close();
      },
      { files: NPM_PROJECT, dependencyInstaller: fakeInstaller(calls) },
    );
  });

  it("adds a batch of runtime and dev packages in one commit", () => {
    const calls: string[] = [];
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        const before = git(ctx.repoDir, "rev-parse", "main");
        w.send(
          request("dev", "feat", {}, [
            { name: "next", version: "^16.0.0" },
            { name: "react" },
            { name: "vitest", dev: true },
            { name: "@types/react", dev: true },
          ]),
        );

        const r = response(await w.next());
        assert.equal(r.outcome, "installed");
        assert.deepEqual(calls, ["next@^16.0.0", "react@latest", "vitest@latest:dev", "@types/react@latest:dev"]);
        assert.equal(git(ctx.repoDir, "rev-list", "--count", `${before}..main`), "1");
        assert.equal(
          git(ctx.repoDir, "log", "-1", "--format=%B", "main").trim(),
          "chore(deps): add 4 packages\n\nnext@^16.0.0\nreact\nvitest (dev)\n@types/react (dev)\n\nRequested by task feat.",
        );
        w.ws.close();
      },
      { files: NPM_PROJECT, dependencyInstaller: fakeInstaller(calls) },
    );
  });

  it("only accepts requests from the node implementing the task", () =>
    withHub(
      async (ctx) => {
        const dev = await implementer(ctx, "dev", "feat");
        const other = await worker(ctx.port, "other");
        other.send(request("other", "feat"));
        const r = response(await other.next());
        assert.ok(r.outcome === "rejected" && /not being implemented by other/.test(r.reason));
        other.send(request("other", "no-such-task"));
        assert.equal(response(await other.next()).outcome, "rejected");
        dev.ws.close();
        other.ws.close();
      },
      { files: NPM_PROJECT, dependencyInstaller: fakeInstaller() },
    ));

  it("enforces the allowlist, including @scope/* rules", () =>
    withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        w.send(request("dev", "feat", { name: "zod" }));
        assert.equal(response(await w.next()).outcome, "installed");
        w.send(request("dev", "feat", { name: "@prisma/client" }));
        assert.equal(response(await w.next()).outcome, "installed");
        w.send(request("dev", "feat", { name: "left-pad" }));
        const r = response(await w.next());
        assert.ok(r.outcome === "rejected" && /not on the Hub's dependency allowlist/.test(r.reason));
        // One disallowed package rejects the whole batch, naming only the offenders.
        w.send(request("dev", "feat", {}, [{ name: "zod" }, { name: "left-pad" }, { name: "is-odd" }]));
        const batch = response(await w.next());
        assert.ok(batch.outcome === "rejected" && /^left-pad, is-odd are not on the Hub's dependency allowlist$/.test(batch.reason), JSON.stringify(batch));
        w.ws.close();
      },
      { files: NPM_PROJECT, dependencyInstaller: fakeInstaller(), allowDependencies: ["zod", "@prisma/*"] },
    ));

  it("rolls back and rejects when the installer fails", () =>
    withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        const before = git(ctx.repoDir, "rev-parse", "main");
        w.send(request("dev", "feat", { name: "does-not-exist" }));
        const r = response(await w.next());
        assert.ok(r.outcome === "rejected" && /E404 not found/.test(r.reason));
        assert.equal(git(ctx.repoDir, "rev-parse", "main"), before);
        assert.equal(git(ctx.repoDir, "status", "--porcelain"), "");
        w.ws.close();
      },
      {
        files: NPM_PROJECT,
        dependencyInstaller: {
          async install(dir) {
            writeFileSync(path.join(dir, "package.json"), "half-written");
            throw new Error("npm ERR! E404 not found");
          },
        },
      },
    ));

  it("rejects installers that touch anything but package.json and the lockfile", () =>
    withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        w.send(request("dev", "feat"));
        const r = response(await w.next());
        assert.ok(r.outcome === "rejected" && /unexpected files: README.md, rogue.js/.test(r.reason));
        assert.equal(git(ctx.repoDir, "status", "--porcelain"), "");
        assert.equal(readFileSync(path.join(ctx.repoDir, "README.md"), "utf8"), "target\n");
        w.ws.close();
      },
      {
        files: NPM_PROJECT,
        dependencyInstaller: {
          async install(dir) {
            writeFileSync(path.join(dir, "README.md"), "pwned\n");
            writeFileSync(path.join(dir, "rogue.js"), "x\n");
          },
        },
      },
    ));

  it("rejects non-npm projects", () =>
    withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        w.send(request("dev", "feat"));
        const r = response(await w.next());
        assert.ok(r.outcome === "rejected" && /only npm projects are supported \(found pnpm-lock.yaml\)/.test(r.reason));
        w.ws.close();
      },
      { files: { "package.json": PKG, "pnpm-lock.yaml": "x\n" }, dependencyInstaller: fakeInstaller() },
    ));

  it("creates package.json for a project that has none, then applies the change", () =>
    withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        w.send(request("dev", "feat"));
        assert.equal(response(await w.next()).outcome, "installed");
        const pkg = JSON.parse(git(ctx.repoDir, "show", "main:package.json"));
        assert.equal(pkg.private, true);
        assert.equal(pkg.version, "0.1.0");
        assert.match(pkg.name, /^aso-target-/, "named after the project directory");
        assert.deepEqual(pkg.asoTestDependencies, { "left-pad": "^1.0.0" });
        w.ws.close();
      },
      { dependencyInstaller: fakeInstaller() },
    ));

  it("sets npm scripts, keeping other fields and formatting", () =>
    withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        w.send(scriptsRequest("dev", "feat", { test: "node --test", build: "tsc" }));
        const r = response(await w.next());
        assert.equal(r.outcome, "installed");
        const text = git(ctx.repoDir, "show", "main:package.json");
        assert.deepEqual(JSON.parse(text), { name: "target", version: "1.0.0", scripts: { lint: "eslint .", test: "node --test", build: "tsc" } });
        assert.match(text, /^\{\n\t"name"/, "tab indentation preserved");
        assert.equal(git(ctx.repoDir, "log", "-1", "--format=%s", "main"), 'chore: set npm scripts test="node --test", build="tsc"');
        assert.equal(git(ctx.repoDir, "show", "--name-only", "--format=", "main"), "package.json");

        // Same scripts again: nothing to commit.
        const before = git(ctx.repoDir, "rev-parse", "main");
        w.send(scriptsRequest("dev", "feat", { test: "node --test" }));
        const again = response(await w.next());
        assert.ok(again.outcome === "installed" && again.mainCommit === before);
        w.ws.close();
      },
      { files: { "package.json": JSON.stringify({ name: "target", version: "1.0.0", scripts: { lint: "eslint ." } }, null, "\t") + "\n" } },
    ));

  it("creates package.json with scripts in an empty project", () =>
    withHub(async (ctx) => {
      const w = await implementer(ctx, "dev", "feat");
      w.send(scriptsRequest("dev", "feat", { test: "node --test" }));
      assert.equal(response(await w.next()).outcome, "installed");
      const pkg = JSON.parse(git(ctx.repoDir, "show", "main:package.json"));
      assert.deepEqual(pkg.scripts, { test: "node --test" });
      assert.equal(pkg.private, true);
      w.ws.close();
    }));

  it("answers retries of the same request without installing twice", () => {
    const calls: string[] = [];
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        const msg = request("dev", "feat");
        w.send(msg);
        const first = response(await w.next());
        w.send({ ...msg, id: crypto.randomUUID() });
        assert.deepEqual(response(await w.next()), first);
        assert.equal(calls.length, 1);
        w.ws.close();
      },
      { files: NPM_PROJECT, dependencyInstaller: fakeInstaller(calls) },
    );
  });

  it("adds a batch of runtime and dev packages in one commit", () => {
    const calls: string[] = [];
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        const before = git(ctx.repoDir, "rev-parse", "main");
        w.send(
          request("dev", "feat", {}, [
            { name: "next", version: "^16.0.0" },
            { name: "react" },
            { name: "vitest", dev: true },
            { name: "@types/react", dev: true },
          ]),
        );

        const r = response(await w.next());
        assert.equal(r.outcome, "installed");
        assert.deepEqual(calls, ["next@^16.0.0", "react@latest", "vitest@latest:dev", "@types/react@latest:dev"]);
        assert.equal(git(ctx.repoDir, "rev-list", "--count", `${before}..main`), "1");
        assert.equal(
          git(ctx.repoDir, "log", "-1", "--format=%B", "main").trim(),
          "chore(deps): add 4 packages\n\nnext@^16.0.0\nreact\nvitest (dev)\n@types/react (dev)\n\nRequested by task feat.",
        );
        w.ws.close();
      },
      { files: NPM_PROJECT, dependencyInstaller: fakeInstaller(calls) },
    );
  });

  it("does not commit when the dependency is already satisfied", () =>
    withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "feat");
        const before = git(ctx.repoDir, "rev-parse", "main");
        w.send(request("dev", "feat"));
        const r = response(await w.next());
        assert.ok(r.outcome === "installed" && r.mainCommit === before);
        assert.equal(git(ctx.repoDir, "rev-parse", "main"), before);
        w.ws.close();
      },
      { files: NPM_PROJECT, dependencyInstaller: { async install() {} } },
    ));

  it("serialises concurrent installs on main", () => {
    let running = 0;
    let maxRunning = 0;
    const inner = fakeInstaller();
    return withHub(
      async (ctx) => {
        const a = await implementer(ctx, "a", "task-a");
        const b = await implementer(ctx, "b", "task-b");
        a.send(request("a", "task-a", { name: "pkg-a" }));
        b.send(request("b", "task-b", { name: "pkg-b" }));
        const [ra, rb] = [response(await a.next(3000)), response(await b.next(3000))];
        assert.equal(ra.outcome, "installed");
        assert.equal(rb.outcome, "installed");
        assert.equal(maxRunning, 1);
        assert.match(git(ctx.repoDir, "log", "--format=%s", "-2", "main"), /pkg-b[\s\S]*pkg-a|pkg-a[\s\S]*pkg-b/);
        a.ws.close();
        b.ws.close();
      },
      {
        files: NPM_PROJECT,
        dependencyInstaller: {
          async install(dir, packages) {
            maxRunning = Math.max(maxRunning, ++running);
            await new Promise((r) => setTimeout(r, 100));
            await inner.install(dir, packages);
            running--;
          },
        },
      },
    );
  });
});

describe("dependency requests (real worker)", () => {
  it("pauses, rebases onto the new main keeping edits, runs npm ci, resumes and merges", () =>
    withHub(
      async (ctx) => {
        const observed: Record<string, unknown> = {};
        const executor: TaskExecutor = {
          async implement(_t, { repoDir, requestDependencies }) {
            writeFiles(repoDir, { "src/uses-dep.ts": "import pad from 'left-pad';\n" });
            const { mainCommit } = await requestDependencies([{ name: "left-pad", version: "^1.3.0" }]);
            const pkg = JSON.parse(readFileSync(path.join(repoDir, "package.json"), "utf8"));
            observed.dep = pkg.asoTestDependencies?.["left-pad"];
            observed.editKept = existsSync(path.join(repoDir, "src/uses-dep.ts"));
            observed.npmCiRan = existsSync(path.join(repoDir, ".ci-ran"));
            observed.mainCommit = mainCommit;
            await assert.rejects(requestDependencies([{ name: "evil-pkg" }]), DependencyRejectedError);
            return { commitMessage: "use left-pad" };
          },
        };
        const dir = tempDir("aso-w-");
        const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", workDir: dir, hardware: hardware(), sandbox: "none", executor });
        try {
          await waitFor(() => ctx.hub.registry.has("dev"));
          await postTask(ctx.port, { taskId: "pad", role: "backend", title: "Use left-pad", description: "d" });
          const record = await waitFor(
            () => ["merged", "failed"].includes(ctx.hub.tasks.get("pad")!.state) && ctx.hub.tasks.get("pad")!,
            30_000,
            "task to finish",
          );
          assert.equal(record.state, "merged", record.history.map((h) => h.event).join("\n"));
          assert.deepEqual(observed, { dep: "^1.3.0", editKept: true, npmCiRan: true, mainCommit: observed.mainCommit });
          // Commits made within the same second have no stable log order; check content and ancestry.
          assert.deepEqual(git(ctx.repoDir, "log", "--format=%s", "main").split("\n").sort(), [
            "Merge task/pad: Use left-pad",
            "chore(deps): add left-pad@^1.3.0",
            "init",
            "use left-pad",
          ]);
          // The task commit was rebased onto the dependency commit.
          assert.equal(git(ctx.repoDir, "log", "-1", "--format=%s", "main^2~1"), "chore(deps): add left-pad@^1.3.0");
          assert.ok(record.history.some((h) => /package change rejected: evil-pkg is not on the Hub's dependency allowlist/.test(h.event)));
        } finally {
          dev.stop();
          await dev.runner.idle();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      {
        files: {
          // postinstall leaves a marker so the test can tell `npm ci` really ran on the worker.
          "package.json": JSON.stringify({
            name: "target",
            version: "1.0.0",
            scripts: { postinstall: "node -e \"require('fs').writeFileSync('.ci-ran','')\"" },
          }),
          "package-lock.json": LOCK(),
          ".gitignore": "node_modules/\n.ci-ran\n",
        },
        dependencyInstaller: fakeInstaller(),
        allowDependencies: ["left-pad"],
        qa: { enabled: false },
      },
    ));
});

describe("empty project bootstrap (real worker)", () => {
  it("lets an agent set up the test script in a repo with no package.json, then passes QA and merges", () =>
    withHub(
      async (ctx) => {
        const executor: TaskExecutor = {
          async implement(_t, { repoDir, setPackageScripts }) {
            writeFiles(repoDir, {
              "src/sum.js": "export const sum = (a, b) => a + b;\n",
              "test/sum.test.js": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "../src/sum.js";\ntest("sum", () => assert.equal(sum(2, 3), 5));\n',
            });
            await setPackageScripts({ test: "node --test" });
            return { commitMessage: "feat: sum" };
          },
        };
        const dirs = [tempDir("aso-dev-"), tempDir("aso-qa-")];
        const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", workDir: dirs[0], hardware: hardware(), sandbox: "none", executor });
        const qa = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "qa", workDir: dirs[1], hardware: hardware(), sandbox: "none" });
        try {
          await waitFor(() => ctx.hub.registry.has("dev") && ctx.hub.registry.has("qa"));
          await postTask(ctx.port, { taskId: "sum", role: "backend", title: "Add sum", description: "d" });
          const record = await waitFor(
            () => ["merged", "failed"].includes(ctx.hub.tasks.get("sum")!.state) && ctx.hub.tasks.get("sum")!,
            30_000,
            "task to finish",
          );
          assert.equal(record.state, "merged", record.history.map((h) => h.event).join("\n"));
          const pkg = JSON.parse(git(ctx.repoDir, "show", "main:package.json"));
          assert.equal(pkg.scripts.test, "node --test");
          // ESM test file without "type": "module": Node detects the syntax, and QA's npm test passed.
          assert.ok(record.history.some((h) => /QA passed/.test(h.event)));
        } finally {
          dev.stop();
          qa.stop();
          await Promise.all([dev.runner.idle(), qa.runner.idle()]);
          for (const d of dirs) rmSync(d, { recursive: true, force: true });
        }
      },
      { qa: { command: ["npm", "test"] } },
    ));
});

describe("npm installer (real registry)", () => {
  let online = false;
  try {
    execFileSync("npm", ["ping"], { stdio: "ignore", timeout: 8000 });
    online = true;
  } catch {
    /* offline */
  }

  it("updates package.json and the lockfile without installing or running scripts", { skip: !online && "npm registry unreachable" }, async () => {
    const dir = makeTargetRepo({ "package.json": PKG });
    try {
      const repo = await HubRepository.open(dir);
      const result = await repo.changePackage(
        { type: "add_dependencies", packages: [{ name: "is-number", version: "^7.0.0", dev: false }, { name: "is-odd", version: "^3.0.0", dev: true }] },
        npmInstaller,
        "chore(deps): add is-number, is-odd",
      );
      assert.ok(result.ok && result.changed, JSON.stringify(result));
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      assert.equal(pkg.dependencies["is-number"], "^7.0.0");
      assert.match(pkg.devDependencies["is-odd"], /^\^3\./);
      const lock = JSON.parse(readFileSync(path.join(dir, "package-lock.json"), "utf8"));
      assert.ok(lock.packages["node_modules/is-number"]);
      assert.equal(existsSync(path.join(dir, "node_modules")), false, "Hub must not install packages");
      assert.equal(git(dir, "status", "--porcelain"), "");
      assert.equal(git(dir, "show", "--name-only", "--format=", "HEAD"), "package-lock.json\npackage.json");

      const bad = await repo.changePackage({ type: "add_dependencies", packages: [{ name: "aso-surely-nonexistent-pkg-x9z", dev: false }] }, npmInstaller, "x");
      assert.ok(!bad.ok && /npm install aso-surely-nonexistent-pkg-x9z failed/.test(bad.reason));
      assert.equal(git(dir, "status", "--porcelain"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
