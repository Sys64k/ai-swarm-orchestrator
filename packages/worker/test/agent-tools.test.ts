import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { agentToolDefinitions } from "@aso/shared";
import { AgentTools, DependencyRejectedError, type ToolResult } from "@aso/worker";

process.env.ASO_LOG_LEVEL ??= "warn";

let root: string;
let repo: string;
let ops: string[];
let deps: string[];
let tools: AgentTools;

const call = (name: string, input: Record<string, unknown>) => tools.execute({ id: "tu_1", name, input });
const ok = (r: ToolResult) => (assert.equal(r.isError, false, r.content), r.content);
const err = (r: ToolResult, re: RegExp) => (assert.equal(r.isError, true, r.content), assert.match(r.content, re));

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "aso-tools-"));
  repo = path.join(root, "repo");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  writeFileSync(path.join(repo, "src/a.ts"), "export const a = 1;\nexport const b = 1;\n");
  writeFileSync(path.join(repo, "package.json"), "{}\n");
  writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
  mkdirSync(path.join(repo, "dist"));
  writeFileSync(path.join(repo, "dist/out.js"), "built\n");
  writeFileSync(path.join(root, "secret.txt"), "top secret\n");
  execFileSync("git", ["init", "-q", repo]);
  ops = [];
  deps = [];
  tools = new AgentTools({
    repoDir: repo,
    taskId: "t1",
    fileOperation: (op) => ops.push(`${op.op} ${op.path}`),
    requestDependency: async (req) => {
      if (req.name === "evil") throw new DependencyRejectedError("not on allowlist");
      deps.push(req.name);
      return { mainCommit: "a".repeat(40) };
    },
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("agent tools", () => {
  it("publishes JSON schemas for every tool", () => {
    const defs = agentToolDefinitions();
    assert.deepEqual(defs.map((d) => d.name), [
      "list_files", "read_file", "search", "write_file", "edit_file", "delete_file", "run_command", "request_dependency", "finish",
    ]);
    for (const d of defs) {
      assert.equal(d.input_schema.type, "object");
      assert.equal(d.input_schema.additionalProperties, false, d.name);
    }
  });

  it("lists files honouring .gitignore", async () => {
    const out = ok(await call("list_files", {}));
    assert.deepEqual(out.split("\n"), [".gitignore", "package.json", "src/a.ts"]);
    assert.equal(ok(await call("list_files", { path: "src" })), "src/a.ts");
  });

  it("reads files with line numbers and paging", async () => {
    assert.equal(ok(await call("read_file", { path: "src/a.ts" })), "1\texport const a = 1;\n2\texport const b = 1;");
    assert.match(ok(await call("read_file", { path: "src/a.ts", offset: 2, limit: 1 })), /^2\texport const b/);
    assert.match(ok(await call("read_file", { path: "src/a.ts", limit: 1 })), /lines 2-2 not shown/);
    err(await call("read_file", { path: "nope.ts" }), /does not exist/);
    writeFileSync(path.join(repo, "img.bin"), Buffer.from([1, 0, 2]));
    err(await call("read_file", { path: "img.bin" }), /binary/);
  });

  it("searches with git grep", async () => {
    assert.equal(ok(await call("search", { pattern: "const b" })), "src/a.ts:2:export const b = 1;");
    assert.equal(ok(await call("search", { pattern: "zzz" })), "(no matches)");
    err(await call("search", { pattern: "(" }), /search failed/);
  });

  it("writes, edits and deletes files and reports each operation", async () => {
    ok(await call("write_file", { path: "src/new/b.ts", content: "x\n" }));
    ok(await call("edit_file", { path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" }));
    err(await call("edit_file", { path: "src/a.ts", old_string: "not in the file", new_string: "x" }), /not found/);
    ok(await call("write_file", { path: "src/a.ts", content: "let x = 1; let y = 1;\n" }));
    err(await call("edit_file", { path: "src/a.ts", old_string: "= 1", new_string: "= 2" }), /occurs 2 times/);
    ok(await call("edit_file", { path: "src/a.ts", old_string: "= 1", new_string: "= 2", replace_all: true }));
    assert.equal(readFileSync(path.join(repo, "src/a.ts"), "utf8"), "let x = 2; let y = 2;\n");
    ok(await call("delete_file", { path: "src/new/b.ts" }));
    assert.deepEqual(ops, ["create src/new/b.ts", "update src/a.ts", "update src/a.ts", "update src/a.ts", "delete src/new/b.ts"]);
  });

  it("keeps the replacement literal (no $& expansion)", async () => {
    ok(await call("edit_file", { path: "src/a.ts", old_string: "a = 1", new_string: "a = '$&$1'" }));
    assert.match(readFileSync(path.join(repo, "src/a.ts"), "utf8"), /a = '\$&\$1'/);
  });

  it("refuses protected files and paths outside the checkout", async () => {
    err(await call("write_file", { path: "package.json", content: "{}" }), /use request_dependency/);
    err(await call("edit_file", { path: "apps/web/package-lock.json", old_string: "a", new_string: "b" }), /managed by the Hub/);
    err(await call("read_file", { path: "../secret.txt" }), /invalid input/);
    err(await call("read_file", { path: "/etc/passwd" }), /invalid input/);
    err(await call("write_file", { path: ".git/config", content: "x" }), /invalid input/);
    symlinkSync(root, path.join(repo, "escape"));
    err(await call("read_file", { path: "escape/secret.txt" }), /outside the project/);
    err(await call("write_file", { path: "escape/pwned.txt", content: "x" }), /outside the project/);
    assert.equal(existsSync(path.join(root, "pwned.txt")), false);
    assert.deepEqual(ops, []);
  });

  it("runs programs without a shell and blocks git, shells and installs", async () => {
    writeFileSync(path.join(repo, "t.mjs"), "console.log('ran', process.env.CI); process.exit(3);\n");
    const r = await call("run_command", { argv: ["node", "t.mjs"] });
    err(r, /^exit code 3/);
    assert.match(r.content, /ran 1/);
    assert.match(ok(await call("run_command", { argv: ["node", "-e", "console.log('a && b')"] })), /exit code 0[\s\S]*a && b/);
    err(await call("run_command", { argv: ["git", "push"] }), /not available to agents/);
    err(await call("run_command", { argv: ["/bin/bash", "-c", "ls"] }), /not available to agents/);
    err(await call("run_command", { argv: ["npm", "install", "left-pad"] }), /use request_dependency/);
    err(await call("run_command", { argv: ["pnpm", "add", "x"] }), /use request_dependency/);
    err(await call("run_command", { argv: ["definitely-not-a-program"] }), /cannot run/);
    err(await call("run_command", { argv: ["node", "-e", "setTimeout(()=>{}, 5000)"], timeout_sec: 1 }), /timed out after 1s/);
  });

  it("requests dependencies through the Hub", async () => {
    assert.match(ok(await call("request_dependency", { name: "zod", version: "^4.0.0" })), /zod@\^4.0.0 is installed/);
    err(await call("request_dependency", { name: "evil" }), /rejected by the Hub: not on allowlist/);
    err(await call("request_dependency", { name: "Bad Name" }), /invalid input/);
    assert.deepEqual(deps, ["zod"]);
  });

  it("validates inputs and rejects unknown tools", async () => {
    err(await call("read_file", { path: "src/a.ts", extra: 1 }), /invalid input/);
    err(await call("rm_rf", {}), /unknown tool/);
    err(await call("finish", { summary: "x", commit_message: "y" }), /unknown tool/);
  });

  it("truncates very large output", async () => {
    writeFileSync(path.join(repo, "big.txt"), ("y".repeat(80) + "\n").repeat(6_000));
    const r = ok(await call("read_file", { path: "big.txt", limit: 5000 }));
    assert.ok(r.length < 51_000);
    assert.match(r, /output truncated/);
  });
});
