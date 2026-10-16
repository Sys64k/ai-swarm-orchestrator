import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { startWorker, type CommandRunner, type TaskExecutor } from "@aso/worker";
import { git, hardware, postTask, tempDir, TOKEN, waitFor, withHub } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

describe("a job in a project with a lockfile", () => {
  it("starts the agent with its dependencies installed, and never commits node_modules", () =>
    withHub(
      async (ctx) => {
        const order: string[] = [];
        const commands: CommandRunner = {
          kind: "host",
          run: async (argv, opts) => {
            order.push(argv.join(" "));
            mkdirSync(path.join(opts.cwd, "node_modules", "left-pad"), { recursive: true });
            writeFileSync(path.join(opts.cwd, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
            return { exitCode: 0, signal: null, timedOut: false, output: "added 1 package", durationMs: 1 };
          },
        };
        const executor: TaskExecutor = {
          async implement(_task, { repoDir }) {
            order.push("agent");
            writeFileSync(path.join(repoDir, "hello.txt"), "hi\n");
            return { summary: "said hello" };
          },
        };
        const w = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", workDir: tempDir(), hardware: hardware(), sandbox: commands, executor });
        try {
          await waitFor(() => ctx.hub.registry.has("dev"));
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "Say hello" });
          const task = await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged" && ctx.hub.tasks.get("greet"), 10_000, "merged");
          assert.deepEqual(order, ["npm ci --no-audit --no-fund", "agent"], "installed before the agent started");
          assert.deepEqual(task.crew?.map((m) => [m.job, m.host, m.slot]), [["implement", "test", 1]], "a real worker reports its desk");
          const files = git(ctx.repoDir, "ls-tree", "-r", "--name-only", task.commit!).split("\n");
          assert.ok(files.includes("hello.txt"));
          assert.ok(!files.some((f) => f.startsWith("node_modules")), "node_modules stays out of the commit, with no .gitignore");
        } finally {
          w.stop();
        }
      },
      { files: { "package.json": '{ "name": "t", "scripts": { "test": "node -e 0" } }\n', "package-lock.json": '{ "lockfileVersion": 3 }\n' }, qa: { enabled: false } },
    ));
});
