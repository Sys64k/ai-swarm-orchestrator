import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { isAuthorized } from "@aso/shared";
import { TOKEN, connect, gitAsync, tempDir, withHub } from "./helpers.ts";

const basic = (password: string) => `Basic ${Buffer.from(`anyone:${password}`).toString("base64")}`;

describe("authentication", () => {
  it("accepts Bearer and Basic (token as password) and nothing else", () => {
    assert.ok(isAuthorized(`Bearer ${TOKEN}`, TOKEN));
    assert.ok(isAuthorized(basic(TOKEN), TOKEN));
    for (const h of [undefined, "", `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, basic("wrong"), `Token ${TOKEN}`]) {
      assert.equal(isAuthorized(h, TOKEN), false, String(h));
    }
  });

  it("protects the API, WebSocket and Git endpoints; health stays minimal", () =>
    withHub(async (ctx) => {
      const url = (p: string) => `http://127.0.0.1:${ctx.port}${p}`;
      for (const p of ["/api/tasks", "/api/nodes", "/api/plans", "/api/llm", "/git/project.git/info/refs?service=git-upload-pack"]) {
        const res = await fetch(url(p));
        assert.equal(res.status, 401, p);
        assert.match(res.headers.get("www-authenticate") ?? "", /Basic/);
      }
      assert.equal((await fetch(url("/api/tasks"), { headers: { authorization: `Bearer wrong` } })).status, 401);
      assert.equal((await fetch(url("/api/tasks"), { headers: { authorization: basic(TOKEN) } })).status, 200);
      const post = await fetch(url("/api/tasks"), { method: "POST", body: "{}" });
      assert.equal(post.status, 401, "writes are protected too");

      assert.deepEqual(await (await fetch(url("/api/health"))).json(), { status: "ok", auth: true });
      const full = await (await fetch(url("/api/health"), { headers: { authorization: `Bearer ${TOKEN}` } })).json();
      assert.equal(full.targetDir, ctx.repoDir);

      await assert.rejects(connect(ctx.port, null), "WebSocket without token");
      await assert.rejects(connect(ctx.port, "wrong"), "WebSocket with a wrong token");
      (await connect(ctx.port)).ws.close();

      const dir = tempDir("aso-clone-");
      try {
        // gitAsync adds the token; a plain clone must fail without prompting.
        // Async on purpose: a sync git call would block the event loop this in-process Hub needs.
        await assert.rejects(
          promisify(execFile)("git", ["clone", "--quiet", ctx.gitUrl, `${dir}/x`], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }),
        );
        await gitAsync(dir, "clone", "--quiet", ctx.gitUrl, "y");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("runs open when started with token null", () =>
    withHub(
      async (ctx) => {
        assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/tasks`)).status, 200);
        (await connect(ctx.port, null)).ws.close();
      },
      { token: null },
    ));
});
