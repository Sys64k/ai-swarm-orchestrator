import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { createMessage, type AgentMessage } from "@aso/shared";
import { pullRequestBody } from "@aso/hub";
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
import { TOKEN } from "./helpers.ts";

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
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
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
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
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
      const dev = await worker(ctx.port, "dev");
      await postTask(ctx.port, task("sneaky"));
      await implement(ctx, dev, "dev", { "package.json": "{}\n", "src/a.ts": "x\n" });

      const again = expectType(await dev.next(), "TASK_ASSIGNMENT").payload;
      assert.match(again.rework!.reason, /protected files: package.json/);
      dev.ws.close();
    }));

  it("refuses a completion whose commit was never pushed", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
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
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
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
        const dev = await worker(ctx.port, "dev");
        await postTask(ctx.port, task("blocked"));
        writeFiles(ctx.repoDir, { "README.md": "someone is editing the Hub checkout\n" });
        await implement(ctx, dev, "dev", { "b.txt": "b\n" });
        const record = await waitFor(() => ctx.hub.tasks.get("blocked")?.state === "failed" && ctx.hub.tasks.get("blocked"));
        assert.match(record.detail!, /merge blocked: .*uncommitted changes: README.md/);
        dev.ws.close();
      },
      { qa: { enabled: false } },
    ));

  it("runs QA on another node than the one that wrote the code, if one is free", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev", { ramGiB: 64 });
      const qa = await worker(ctx.port, "qa", { ramGiB: 4 });
      await postTask(ctx.port, task("independent"));
      const { commit } = await implement(ctx, dev, "dev", { "i.txt": "i\n" });
      assert.equal(expectType(await qa.next(), "TEST_EXECUTION").payload.commit, commit);
      assert.equal(ctx.hub.tasks.get("independent")?.qaNodeId, "qa");
      for (const c of [dev, qa]) c.ws.close();
    }));

  it("retries QA on another node when the QA node cannot run tests", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      await postTask(ctx.port, task("flaky-infra"));
      const { commit } = await implement(ctx, dev, "dev", { "c.txt": "c\n" });
      // The only node also runs QA: any node takes any job.
      expectType(await dev.next(), "TEST_EXECUTION");
      dev.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "flaky-infra", detail: "npm: not found" }));
      const qa = await worker(ctx.port, "qa", { ramGiB: 8 });
      // dev is free again and may be picked again; either way QA is re-dispatched.
      const next = await Promise.race([dev.next(), qa.next()]);
      assert.equal(expectType(next, "TEST_EXECUTION").payload.commit, commit);
      assert.equal(ctx.hub.tasks.get("flaky-infra")?.qaAttempts, 2);
      for (const c of [dev, qa]) c.ws.close();
    }));

  it("adds npm ci as a QA setup step when the commit has a package-lock.json", () =>
    withHub(
      async (ctx) => {
        const dev = await worker(ctx.port, "dev");
        const qa = await worker(ctx.port, "qa");
        await postTask(ctx.port, task("deps"));
        await implement(ctx, dev, "dev", { "d.txt": "d\n" });
        assert.deepEqual(expectType(await qa.next(), "TEST_EXECUTION").payload.setup, [["npm", "ci"]]);
        dev.ws.close();
        qa.ws.close();
      },
      { files: { "package-lock.json": "{}\n" } },
    ));

  it("keeps the screenshots of the last passing QA run, serves them, and drops them when a later run takes none", () =>
    withHub(async (ctx) => {
      const dev = await worker(ctx.port, "dev");
      const qa = await worker(ctx.port, "qa");
      await postTask(ctx.port, task("shots"));
      const { commit } = await implement(ctx, dev, "dev", { "s.txt": "s\n" });
      expectType(await qa.next(), "TEST_EXECUTION");
      qa.send(createMessage("STATUS_UPDATE", "qa", { state: "in_progress", taskId: "shots" }));
      qa.send(createMessage("FEEDBACK_LOOP", "qa", {
        taskId: "shots", commit, outcome: "pass", summary: "ok; 2 screenshots",
        screenshots: [{ name: "desk-dark.png", mediaType: "image/png", data: PNG_1X1 }, { name: "page.webp", mediaType: "image/webp", data: "UklGRg==" }],
      }));
      const record = await waitFor(() => ctx.hub.tasks.get("shots")?.screenshots && ctx.hub.tasks.get("shots"));
      assert.equal(record.screenshots!.commit, commit);
      assert.deepEqual(record.screenshots!.files, [
        { name: "desk-dark.png", mediaType: "image/png", bytes: 70 },
        { name: "page.webp", mediaType: "image/webp", bytes: 4 },
      ]);

      const get = (name: string) => fetch(`http://127.0.0.1:${ctx.port}/api/tasks/shots/screenshots/${name}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      const png = await get("desk-dark.png");
      assert.equal(png.status, 200);
      assert.equal(png.headers.get("content-type"), "image/png");
      assert.equal(png.headers.get("x-content-type-options"), "nosniff");
      assert.equal(Buffer.from(await png.arrayBuffer()).toString("base64"), PNG_1X1);
      assert.equal((await get("missing.png")).status, 404);
      assert.equal((await get("..%2Fstate.json")).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/tasks/shots/screenshots/desk-dark.png`)).status, 401, "needs the token like the rest of the API");

      assert.match(pullRequestBody(record), /\*\*Screenshots\*\* \(2\): `desk-dark\.png`, `page\.webp`; see them on the task in the ASO console/);
      assert.match(pullRequestBody(record, "https://hub.example.ts.net/"), /\[see them in the ASO console\]\(https:\/\/hub\.example\.ts\.net\/tasks\/shots\)/);

      // A later passing run without screenshots: the old ones would show the wrong commit.
      // (Set up by hand: the first run merged the task, and no review gate sends it back.)
      Object.assign(ctx.hub.tasks.get("shots")!, { state: "testing", qaNodeId: "qa" });
      assert.equal(ctx.hub.projects.taskOwner("shots")!.tasks.handleFeedback("qa", { taskId: "shots", commit, outcome: "pass", summary: "ok" }), undefined);
      assert.equal(ctx.hub.tasks.get("shots")!.screenshots, undefined);
      // Let the second approval's merge settle before the Hub and its checkout go away.
      await waitFor(() => ["merged", "failed"].includes(ctx.hub.tasks.get("shots")!.state));
      assert.equal((await get("desk-dark.png")).status, 404);
      assert.doesNotMatch(pullRequestBody(ctx.hub.tasks.get("shots")!), /Screenshots/);
      dev.ws.close();
      qa.ws.close();
    }));
});

/** The smallest valid PNG: 1×1 pixel. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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
          token: TOKEN,
          nodeId: "dev",
          workDir: dirs[0],
          hardware: hardware(), sandbox: "none",
          executor,
        });
        const qa = await startWorker({
          hub: `127.0.0.1:${ctx.port}`,
          token: TOKEN,
          nodeId: "qa",
          workDir: dirs[1],
          hardware: hardware(), sandbox: "none",
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

  it("runs the project's screenshots script after passing tests and hands the images to the Hub", () =>
    withHub(
      async (ctx) => {
        const executor: TaskExecutor = {
          async implement(_t, { repoDir }) {
            writeFiles(repoDir, { "greeting.txt": "hello\n" });
            return { commitMessage: "feat: greeting" };
          },
        };
        const dirs = [tempDir("aso-w1-"), tempDir("aso-w2-")];
        const start = (nodeId: string, workDir: string, extra: { executor?: TaskExecutor } = {}) =>
          startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId, workDir, hardware: hardware(), sandbox: "none", ...extra });
        const dev = await start("dev", dirs[0], { executor });
        const qa = await start("qa", dirs[1]);
        try {
          await waitFor(() => ctx.hub.registry.has("dev") && ctx.hub.registry.has("qa"));
          await postTask(ctx.port, task("look"));
          const record = await waitFor(() => ["merged", "failed"].includes(ctx.hub.tasks.get("look")!.state) && ctx.hub.tasks.get("look")!, 30_000, "task to finish");
          assert.equal(record.state, "merged", record.history.map((h) => h.event).join("\n"));
          assert.deepEqual(record.screenshots?.files, [{ name: "desk.png", mediaType: "image/png", bytes: 70 }]);
          assert.equal(record.qaSummary, "`npm test` passed; 1 screenshot, left out: bad name.png (name not allowed: letters, digits and ._- only), notes.txt (not a PNG, JPEG, GIF or WebP image)");
          const res = await fetch(`http://127.0.0.1:${ctx.port}/api/tasks/look/screenshots/desk.png`, { headers: { authorization: `Bearer ${TOKEN}` } });
          assert.equal(Buffer.from(await res.arrayBuffer()).toString("base64"), PNG_1X1);
          assert.equal(git(ctx.repoDir, "ls-tree", "-r", "--name-only", "main").includes(".aso-screenshots"), false);
        } finally {
          dev.stop();
          qa.stop();
          await Promise.all([dev.runner.idle(), qa.runner.idle()]);
          for (const d of dirs) rmSync(d, { recursive: true, force: true });
        }
      },
      {
        files: {
          "package.json": JSON.stringify({ name: "shots", private: true, scripts: { test: "node -e 0", screenshots: "node shot.mjs" } }),
          "shot.mjs": `
import { writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.env.ASO_SCREENSHOT_DIR;
writeFileSync(path.join(dir, "desk.png"), Buffer.from("${"${PNG}"}", "base64"));
writeFileSync(path.join(dir, "bad name.png"), Buffer.from("${"${PNG}"}", "base64"));
writeFileSync(path.join(dir, "notes.txt"), "not an image");
`.replaceAll("${PNG}", PNG_1X1),
        },
      },
    ));

  it("hands the views the developer listed to the screenshots script", () =>
    withHub(
      async (ctx) => {
        const targets = [
          { name: "page-dark", path: "/tasks/t-1", theme: "dark" as const },
          { name: "page-phone", path: "/tasks/t-1", width: 412, selector: "#shots", state: "with-screenshots" },
          { name: "page-broken", path: "/broken" },
        ];
        const executor: TaskExecutor = {
          async implement(_t, { repoDir }) {
            writeFiles(repoDir, { "page.txt": "a page\n" });
            return { commitMessage: "feat: page", screenshotTargets: targets };
          },
        };
        const dirs = [tempDir("aso-w1-"), tempDir("aso-w2-")];
        const start = (nodeId: string, workDir: string, extra: { executor?: TaskExecutor } = {}) =>
          startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId, workDir, hardware: hardware(), sandbox: "none", ...extra });
        const dev = await start("dev", dirs[0], { executor });
        const qa = await start("qa", dirs[1]);
        try {
          await waitFor(() => ctx.hub.registry.has("dev") && ctx.hub.registry.has("qa"));
          await postTask(ctx.port, task("views"));
          const record = await waitFor(() => ["merged", "failed"].includes(ctx.hub.tasks.get("views")!.state) && ctx.hub.tasks.get("views")!, 30_000, "task to finish");
          assert.equal(record.state, "merged", record.history.map((h) => h.event).join("\n"));
          assert.deepEqual(record.screenshotTargets, targets);
          // The script saved one image per view, named after it: it got the list.
          assert.deepEqual(record.screenshots?.files.map((f) => f.name), ["page-dark.png", "page-phone.png"]);
          assert.equal(record.qaSummary, "`npm test` passed; 2 screenshots, views not saved (1 of 3): page-broken");
        } finally {
          dev.stop();
          qa.stop();
          await Promise.all([dev.runner.idle(), qa.runner.idle()]);
          for (const d of dirs) rmSync(d, { recursive: true, force: true });
        }
      },
      {
        files: {
          "package.json": JSON.stringify({ name: "views", private: true, scripts: { test: "node -e 0", screenshots: "node shot.mjs" } }),
          "shot.mjs": `
import { writeFileSync } from "node:fs";
import path from "node:path";
const targets = JSON.parse(process.env.ASO_SCREENSHOT_TARGETS ?? "[]");
for (const t of targets.filter((t) => t.path !== "/broken")) writeFileSync(path.join(process.env.ASO_SCREENSHOT_DIR, t.name + ".png"), Buffer.from("${"${PNG}"}", "base64"));
`.replaceAll("${PNG}", PNG_1X1),
        },
      },
    ));

  it("notes a failing screenshots script without failing QA", () =>
    withHub(
      async (ctx) => {
        const dir = tempDir("aso-w-");
        // The fake implementer takes the task before the real QA worker connects.
        const dev = await worker(ctx.port, "dev");
        await postTask(ctx.port, task("broken-shots"));
        expectType(await dev.next(), "TASK_ASSIGNMENT");
        const qa = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "qa", workDir: dir, hardware: hardware(), sandbox: "none" });
        try {
          await waitFor(() => ctx.hub.registry.has("qa"));
          dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "broken-shots" }));
          const commit = await pushTaskBranch(ctx.gitUrl, "broken-shots", { "b.txt": "b\n" });
          dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "broken-shots", commit }));
          const record = await waitFor(() => ["merged", "failed"].includes(ctx.hub.tasks.get("broken-shots")!.state) && ctx.hub.tasks.get("broken-shots")!, 30_000, "task to finish");
          assert.equal(record.state, "merged");
          assert.equal(record.qaSummary, "`npm test` passed; no screenshots: `npm run screenshots` exited with 3");
          assert.equal(record.screenshots, undefined);
        } finally {
          dev.ws.close();
          qa.stop();
          await qa.runner.idle();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      { files: { "package.json": JSON.stringify({ name: "s", private: true, scripts: { test: "node -e 0", screenshots: "exit 3" } }) } },
    ));

  it("fails the task with a clear reason when the Hub has no LLM configured", () =>
    withHub(async (ctx) => {
      const dir = tempDir("aso-w-");
      const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", workDir: dir, hardware: hardware(), sandbox: "none" });
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
