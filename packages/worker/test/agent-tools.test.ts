import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { agentToolDefinitions, IMAGE_MAX_BYTES, MAX_FRAME_BYTES, TURN_IMAGE_BUDGET } from "@aso/shared";
import { AgentTools, DependencyRejectedError, fitTurnResults, hostRunner, probeImage, type ToolResult } from "@aso/worker";

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
    role: "backend",
    commands: hostRunner,
    fileOperation: (op) => ops.push(`${op.op} ${op.path}`),
    requestDependencies: async (packages) => {
      if (packages.some((p) => p.name === "evil")) throw new DependencyRejectedError("not on allowlist");
      deps.push(...packages.map((p) => p.name));
      return { mainCommit: "a".repeat(40) };
    },
    setPackageScripts: async (scripts) => {
      deps.push(`scripts:${Object.keys(scripts).join(",")}`);
      return { mainCommit: "b".repeat(40) };
    },
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("agent tools", () => {
  it("publishes JSON schemas for every tool", () => {
    const defs = agentToolDefinitions();
    assert.deepEqual(defs.map((d) => d.name), [
      "list_files", "read_file", "search", "view_image", "write_file", "edit_file", "delete_file", "run_command", "request_dependencies", "set_package_scripts", "finish", "submit_plan", "ask_questions",
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
    err(await call("write_file", { path: "package.json", content: "{}" }), /use request_dependencies/);
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
    err(await call("run_command", { argv: ["npm", "install", "left-pad"] }), /use request_dependencies/);
    err(await call("run_command", { argv: ["pnpm", "add", "x"] }), /use request_dependencies/);
    err(await call("run_command", { argv: ["definitely-not-a-program"] }), /cannot run/);
    err(await call("run_command", { argv: ["node", "-e", "setTimeout(()=>{}, 5000)"], timeout_sec: 1 }), /timed out after 1s/);
  });

  it("requests dependencies through the Hub", async () => {
    assert.match(ok(await call("request_dependencies", { packages: [{ name: "zod", version: "^4.0.0" }] })), /zod@\^4.0.0 is installed/);
    assert.match(
      ok(await call("request_dependencies", { packages: [{ name: "react" }, { name: "vitest", dev: true }] })),
      /react, vitest are installed/,
    );
    err(await call("request_dependencies", { packages: [{ name: "zod" }, { name: "evil" }] }), /rejected by the Hub: not on allowlist/);
    err(await call("request_dependencies", { packages: [{ name: "Bad Name" }] }), /invalid input/);
    err(await call("request_dependencies", { packages: [] }), /invalid input/);
    err(await call("request_dependencies", { packages: [{ name: "zod" }, { name: "zod" }] }), /invalid input/);
    assert.match(ok(await call("set_package_scripts", { scripts: { test: "node --test" } })), /scripts updated on main @ bbbbbbbb \(test\)/);
    err(await call("set_package_scripts", { scripts: { postinstall: "x" } }), /invalid input/);
    assert.deepEqual(deps, ["zod", "react", "vitest", "scripts:test"]);
  });

  it("shows an image to the model, with its type and size in words", async () => {
    const png = pngHeader(1400, 900);
    writeFileSync(path.join(repo, "shot.png"), png);
    const r = await call("view_image", { path: "shot.png" });
    assert.equal(ok(r), "shot.png: PNG, 1400×900 pixels, 1 KB");
    assert.deepEqual(r.image, { mediaType: "image/png", data: png.toString("base64") });
    // The type comes from the bytes, not the name.
    writeFileSync(path.join(repo, "shot.jpg"), png);
    assert.equal((await call("view_image", { path: "shot.jpg" })).image?.mediaType, "image/png");
  });

  it("refuses files that aren't images, are too big, or are outside the checkout", async () => {
    err(await call("view_image", { path: "src/a.ts" }), /src\/a\.ts is not a PNG, JPEG, GIF or WebP image/);
    err(await call("view_image", { path: "missing.png" }), /missing\.png does not exist/);
    err(await call("view_image", { path: "src" }), /is a directory/);
    err(await call("view_image", { path: "../secret.txt" }), /must not contain '\.\.'/);
    symlinkSync(path.join(root, "secret.txt"), path.join(repo, "secret.png"));
    err(await call("view_image", { path: "secret.png" }), /resolves outside the project/);
    writeFileSync(path.join(repo, "huge.png"), Buffer.concat([pngHeader(800, 600), Buffer.alloc(2_000_001)]));
    err(await call("view_image", { path: "huge.png" }), /huge\.png is 2,001 KB, over the 2 MB limit; screenshot a smaller area/);
    writeFileSync(path.join(repo, "tall.png"), pngHeader(1000, 8001));
    err(await call("view_image", { path: "tall.png" }), /1000×8001 pixels; the model takes at most 8000 on a side/);
    writeFileSync(path.join(repo, "empty.png"), pngHeader(0, 10));
    err(await call("view_image", { path: "empty.png" }), /has no pixels/);
    assert.equal((await call("view_image", { path: "src/a.ts" })).image, undefined);
  });

  it("reads the type and size of PNG, JPEG, GIF and WebP headers", () => {
    assert.deepEqual(probeImage(pngHeader(3, 4)), { mediaType: "image/png", width: 3, height: 4 });
    // JPEG: SOI, an APP0 segment to skip, a fill byte, then a baseline frame header (SOF0).
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
      0xff, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03,
    ]);
    assert.deepEqual(probeImage(jpeg), { mediaType: "image/jpeg", width: 600, height: 300 });
    // Image data before any frame header: no size to read.
    assert.equal(probeImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])), undefined);
    const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([0x40, 0x01, 0xf0, 0x00])]);
    assert.deepEqual(probeImage(gif), { mediaType: "image/gif", width: 320, height: 240 });
    const webp = (chunk: string, body: number[]) => {
      const b = Buffer.alloc(30);
      b.write("RIFF", 0, "latin1");
      b.write("WEBP", 8, "latin1");
      b.write(chunk, 12, "latin1");
      Buffer.from(body).copy(b, 20);
      return b;
    };
    // Lossy: 14-bit sizes at bytes 26 and 28.
    assert.deepEqual(probeImage(webp("VP8 ", [0, 0, 0, 0, 0, 0, 0x90, 0x01, 0xc8, 0x00])), { mediaType: "image/webp", width: 400, height: 200 });
    // Lossless: (width-1) and (height-1) packed in 14 bits each from byte 21.
    assert.deepEqual(probeImage(webp("VP8L", [0, 0x8f, 0x01, 0x32, 0x00])), { mediaType: "image/webp", width: 400, height: 201 });
    // Extended: 24-bit (width-1) and (height-1) at bytes 24 and 27.
    assert.deepEqual(probeImage(webp("VP8X", [0, 0, 0, 0, 0x8f, 0x01, 0x00, 0xc7, 0x00, 0x00])), { mediaType: "image/webp", width: 400, height: 200 });
    assert.equal(probeImage(Buffer.from("not an image")), undefined);
    assert.equal(probeImage(pngHeader(1, 1).subarray(0, 20)), undefined);
  });

  it("fits a turn's results into one frame, leaving out images past the turn's budget", () => {
    const image = { mediaType: "image/png" as const, data: "A".repeat(Math.ceil(IMAGE_MAX_BYTES / 3) * 4) };
    const shot = (id: string): ToolResult => ({ toolUseId: id, content: `${id}.png`, isError: false, image });
    const text = (id: string, n: number): ToolResult => ({ toolUseId: id, content: "x".repeat(n), isError: false });
    const fitted = fitTurnResults([shot("a"), text("t", 2_000_000), shot("b"), shot("c")]);
    assert.deepEqual(fitted.map((r) => Boolean(r.image)), [true, false, true, false]);
    assert.equal(fitted[3].isError, true);
    assert.equal(fitted[3].content, "c.png\nImage not sent: this turn's images are over 4.1 MB together. View it again in a later turn.");
    assert.match(fitted[1].content, /… truncated to fit this turn$/);
    // Two full-size images and the text budget fit in a frame, with room for the envelope.
    const frame = JSON.stringify({ type: "PROMPT_EXECUTION", payload: { toolResults: fitted } });
    assert.ok(Buffer.byteLength(frame) < MAX_FRAME_BYTES - 500_000, `${Buffer.byteLength(frame)} bytes`);
    assert.ok(2 * image.data.length <= TURN_IMAGE_BUDGET, "two full-size images fit in one turn");
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

  it("enforces role scopes: QA writes tests only, Architect is read-only", async () => {
    const as = (role: "qa" | "architect" | "devops") =>
      new AgentTools({
        repoDir: repo,
        role,
        commands: hostRunner,
        fileOperation: (op) => ops.push(`${op.op} ${op.path}`),
        requestDependencies: async () => ({ mainCommit: "a".repeat(40) }),
        setPackageScripts: async () => ({ mainCommit: "b".repeat(40) }),
      });
    const qa = as("qa");
    const qaCall = (name: string, input: Record<string, unknown>) => qa.execute({ id: "tu", name, input });
    ok(await qaCall("write_file", { path: "test/a.test.js", content: "x" }));
    err(await qaCall("edit_file", { path: "src/a.ts", old_string: "a", new_string: "b" }), /qa role may only modify test files/);
    err(await qaCall("write_file", { path: "src/b.ts", content: "x" }), /outside that scope/);
    ok(await qaCall("read_file", { path: "src/a.ts" }));

    const arch = as("architect");
    ok(await arch.execute({ id: "tu", name: "list_files", input: {} }));
    err(await arch.execute({ id: "tu", name: "write_file", input: { path: "x.md", content: "x" } }), /not available to the architect role/);
    err(await arch.execute({ id: "tu", name: "run_command", input: { argv: ["node", "-v"] } }), /not available to the architect role/);

    ok(await as("devops").execute({ id: "tu", name: "write_file", input: { path: ".github/workflows/ci.yml", content: "on: push" } }));
    assert.deepEqual(ops, ["create test/a.test.js", "create .github/workflows/ci.yml"]);
  });
});

/** The first bytes of a PNG: signature and IHDR, which is all the tool reads. */
function pngHeader(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
