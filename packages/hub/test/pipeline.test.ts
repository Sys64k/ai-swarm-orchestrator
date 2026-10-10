import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { createMessage, type AgentMessage } from "@aso/shared";
import { startWorker, type TaskExecutor } from "@aso/worker";
import {
  git,
  hardware,
  postTask,
  pushTaskBranch,
  tempDir,
  waitFor,
  withHub,
  worker,
  writeFiles,
  type HubContext,
  type TestClient,
} from "./helpers.ts";

const task = (taskId: string) => ({ taskId, role: "backend", title: `Task ${taskId}`, description: "d" });

function expectType<T extends AgentMessage["type"]>(m: AgentMessage, type: T): Extract<AgentMessage, { type: T }> {
  assert.equal(m.type, type);
  return m as Extract<AgentMessage, { type: T }>;
}

/** Fake implementer: take the assignment, push files to task/<id>, report completion. */
async function implement(ctx: HubContext, w: TestClient, nodeId: string, files: Record<string, string>) {
  const assignment = expectType(await w.next(), "TASK_ASSIGNMENT").payload;
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "in_progress", taskId: assignment.taskId }));
  const commit = await pushTaskBranch(ctx.gitUrl, assignment.taskId, files);
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "completed", taskId: assignment.taskId, commit }));
  return { assignment, commit };
}

describe("QA pipeline (fake nodes)", () => {
  it("verifies, tests and merges a task into main", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
      const qa = await worker(ctx.port, "qa", { roles: ["qa"] });
      await postTask(ctx.port, task("greet"));
      const { commit } = await implement(ctx, dev, "dev", { "greeting.txt": "hello\n" });

      const run = expectType(await qa.next(), "TEST_EXECUTION").payload;
      assert.equal(run.commit, commit);
      assert.deepEqual(run.command, ["npm", "test"]);
      assert.deepEqual(run.setup, [], "no package-lock.json, so no npm ci");
      qa.send(createMessage("STATUS_UPDATE", "qa", { state: "in_progress", taskId: "greet" }));
      qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId: "greet", commit, outcome: "pass", summary: "ok" }));

      const record = await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged" && ctx.hub.tasks.get("greet"));
      assert.equal(git(ctx.repoDir, "rev-parse", "main"), record.mainCommit);
      assert.equal(git(ctx.repoDir, "show", "main:greeting.txt"), "hello");
      assert.equal(git(ctx.repoDir, "log", "-1", "--format=%s|%an", "main"), "Merge task/greet: Task greet|ASO Hub");
      assert.equal(git(ctx.repoDir, "status", "--porcelain"), "");
      dev.ws.close();
      qa.ws.close();
    }));

  it("sends failed QA back to the implementer with the failures", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
      const qa = await worker(ctx.port, "qa", { roles: ["qa"] });
      await postTask(ctx.port, task("greet"));
      const { commit } = await implement(ctx, dev, "dev", { "greeting.txt": "helo\n" });
      expectType(await qa.next(), "TEST_EXECUTION");
      qa.send(
        createMessage("FEEDBACK_LOOP", "qa", {
          taskId: "greet",
          commit,
          outcome: "fail",
          summary: "1 test failed",
          failures: [{ test: "greeting", message: "expected hello" }],
          output: "AssertionError: expected hello",
        }),
      );

      const again = expectType(await dev.next(), "TASK_ASSIGNMENT").payload;
      assert.equal(again.taskId, "greet");
      assert.equal(again.rework?.round, 1);
      assert.match(again.rework!.reason, /QA failed: 1 test failed/);
      assert.deepEqual(again.rework!.failures, [{ test: "greeting", message: "expected hello" }]);
      assert.equal(again.rework!.output, "AssertionError: expected hello");
      dev.ws.close();
      qa.ws.close();
    }));

  it("refuses work that changed package.json, even if the worker skipped its own check", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
      await postTask(ctx.port, task("sneaky"));
      await implement(ctx, dev, "dev", { "package.json": "{}\n", "src/a.ts": "x\n" });

      const again = expectType(await dev.next(), "TASK_ASSIGNMENT").payload;
      assert.match(again.rework!.reason, /protected files: package.json/);
      dev.ws.close();
    }));

  it("refuses a completion whose commit was never pushed", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
      await postTask(ctx.port, task("liar"));
      expectType(await dev.next(), "TASK_ASSIGNMENT");
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "liar" }));
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "liar", commit: "c".repeat(40) }));
      const again = expectType(await dev.next(), "TASK_ASSIGNMENT").payload;
      assert.match(again.rework!.reason, /task\/liar was not pushed/);
      dev.ws.close();
    }));

  it("turns a merge conflict with main into a rework round", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
      const qa = await worker(ctx.port, "qa", { roles: ["qa"] });
      await postTask(ctx.port, task("clash"));
      const { commit } = await implement(ctx, dev, "dev", { "README.md": "task version\n" });
      expectType(await qa.next(), "TEST_EXECUTION");

      // main moves on while QA runs
      writeFiles(ctx.repoDir, { "README.md": "main version\n" });
      git(ctx.repoDir, "commit", "--quiet", "-am", "concurrent change");
      const mainBefore = git(ctx.repoDir, "rev-parse", "main");

      qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId: "clash", commit, outcome: "pass", summary: "ok" }));
      const again = expectType(await dev.next(), "TASK_ASSIGNMENT").payload;
      assert.match(again.rework!.reason, /merge conflict with main in README.md/);
      assert.equal(git(ctx.repoDir, "rev-parse", "main"), mainBefore);
      assert.equal(git(ctx.repoDir, "status", "--porcelain"), "", "aborted merge must leave the checkout clean");
      dev.ws.close();
      qa.ws.close();
    }));

  it("fails instead of merging into a dirty Hub checkout", () =>
    withHub(
      async (ctx) => {
        const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
        await postTask(ctx.port, task("blocked"));
        writeFiles(ctx.repoDir, { "README.md": "someone is editing the Hub checkout\n" });
        await implement(ctx, dev, "dev", { "b.txt": "b\n" });
        const record = await waitFor(() => ctx.hub.tasks.get("blocked")?.state === "failed" && ctx.hub.tasks.get("blocked"));
        assert.match(record.detail!, /merge blocked: .*uncommitted changes: README.md/);
        dev.ws.close();
      },
      { qa: { enabled: false } },
    ));

  it("retries QA on another node when the QA node cannot run tests", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
      const qa1 = await worker(ctx.port, "qa1", { roles: ["qa"], ramGiB: 64 });
      await postTask(ctx.port, task("flaky-infra"));
      const { commit } = await implement(ctx, dev, "dev", { "c.txt": "c\n" });
      expectType(await qa1.next(), "TEST_EXECUTION");
      qa1.send(createMessage("STATUS_UPDATE", "qa1", { state: "failed", taskId: "flaky-infra", detail: "npm: not found" }));
      const qa2 = await worker(ctx.port, "qa2", { roles: ["qa"], ramGiB: 8 });
      // qa1 is free again and scores higher, so it may be picked again; either way QA is re-dispatched.
      const next = await Promise.race([qa1.next(), qa2.next()]);
      assert.equal(expectType(next, "TEST_EXECUTION").payload.commit, commit);
      assert.equal(ctx.hub.tasks.get("flaky-infra")?.qaAttempts, 2);
      for (const c of [dev, qa1, qa2]) c.ws.close();
    }));

  it("adds npm ci as a QA setup step when the commit has a package-lock.json", () =>
    withHub(
      async (ctx) => {
        const dev = await worker(ctx.port, "dev", { roles: ["backend"] });
        const qa = await worker(ctx.port, "qa", { roles: ["qa"] });
        await postTask(ctx.port, task("deps"));
        await implement(ctx, dev, "dev", { "d.txt": "d\n" });
        assert.deepEqual(expectType(await qa.next(), "TEST_EXECUTION").payload.setup, [["npm", "ci"]]);
        dev.ws.close();
        qa.ws.close();
      },
      { files: { "package-lock.json": "{}\n" } },
    ));
});

describe("QA pipeline (real workers)", () => {
  const CHECK = `
import { readFileSync } from "node:fs";
const text = readFileSync("greeting.txt", "utf8");
if (text !== "hello\\n") { console.error("expected 'hello', got " + JSON.stringify(text)); process.exit(1); }
console.log("greeting ok");
`;

  it("implements, fails QA, reworks with feedback, passes and merges", () =>
    withHub(
      async (ctx) => {
        const seen: Array<{ round?: number; output?: string }> = [];
        const executor: TaskExecutor = {
          async implement(t, { repoDir }) {
            seen.push({ round: t.rework?.round, output: t.rework?.output });
            // First attempt has a typo; the rework round fixes it.
            writeFiles(repoDir, { "greeting.txt": t.rework ? "hello\n" : "helo\n" });
            return { commitMessage: `feat: greeting (round ${t.rework?.round ?? 0})` };
          },
        };
        const dirs = [tempDir("aso-w1-"), tempDir("aso-w2-")];
        const dev = await startWorker({
          hub: `127.0.0.1:${ctx.port}`,
          nodeId: "dev",
          roles: ["backend"],
          workDir: dirs[0],
          hardware: hardware(),
          executor,
        });
        const qa = await startWorker({
          hub: `127.0.0.1:${ctx.port}`,
          nodeId: "qa",
          roles: ["qa"],
          workDir: dirs[1],
          hardware: hardware(),
        });
        try {
          await waitFor(() => ctx.hub.registry.has("dev") && ctx.hub.registry.has("qa"));
          await postTask(ctx.port, task("greet"));
          const record = await waitFor(
            () => ["merged", "failed"].includes(ctx.hub.tasks.get("greet")!.state) && ctx.hub.tasks.get("greet")!,
            30_000,
            "task to finish",
          );
          assert.equal(record.state, "merged", record.history.map((h) => h.event).join("\n"));
          assert.equal(record.reworkRound, 1);
          assert.equal(seen.length, 2);
          assert.equal(seen[1].round, 1);
          assert.match(seen[1].output!, /expected 'hello', got "helo\\n"/);

          assert.equal(git(ctx.repoDir, "show", "main:greeting.txt"), "hello");
          const log = git(ctx.repoDir, "log", "--format=%s|%an", "main");
          assert.match(log, /^Merge task\/greet: Task greet\|ASO Hub/);
          assert.match(log, /feat: greeting \(round 1\)\|ASO backend agent \(dev\)/);
          assert.match(log, /feat: greeting \(round 0\)\|ASO backend agent \(dev\)/);
        } finally {
          dev.stop();
          qa.stop();
          await Promise.all([dev.runner.idle(), qa.runner.idle()]);
          for (const d of dirs) rmSync(d, { recursive: true, force: true });
        }
      },
      { files: { "check.mjs": CHECK }, qa: { command: ["node", "check.mjs"] } },
    ));

  it("fails the task with a clear reason when the Hub has no LLM configured", () =>
    withHub(async (ctx) => {
      const dir = tempDir("aso-w-");
      const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, nodeId: "dev", roles: ["backend"], workDir: dir, hardware: hardware() });
      try {
        await waitFor(() => ctx.hub.registry.has("dev"));
        await postTask(ctx.port, task("nobody-home"));
        const record = await waitFor(() => ctx.hub.tasks.get("nobody-home")?.state === "failed" && ctx.hub.tasks.get("nobody-home"));
        assert.match(record.history.at(-1)!.event, /no LLM configured on the Hub/);
      } finally {
        dev.stop();
        await dev.runner.idle();
        rmSync(dir, { recursive: true, force: true });
      }
    }));
});
