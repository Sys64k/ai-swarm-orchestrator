import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startHub } from "@aso/hub";
import { startDeployRunner } from "../dist/deploy-runner.js";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const TOKEN = "test-token-deploy-runner";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("the host deploy runner", () => {
  it("runs the Hub's deploy jobs on the host, in the shared export, and reports back", async () => {
    const root = path.join(os.tmpdir(), `aso-runner-${process.pid}-${Date.now()}`);
    const repo = path.join(root, "shop");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    writeFileSync(path.join(repo, "app.txt"), "v1\n");
    git(repo, "add", "-A");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "first");
    mkdirSync(path.join(root, ".aso"), { recursive: true });
    const marker = path.join(root, "ran-on-host");
    writeFileSync(path.join(root, ".aso", "deploy.json"), JSON.stringify({ shop: { command: `cat app.txt > "${marker}"; echo "$ASO_DEPLOY_SHORT"` } }));

    const hub = await startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false }, deploy: { runner: "host" } });
    const runner = startDeployRunner({ hubUrl: `http://127.0.0.1:${hub.port}`, token: TOKEN, root, pollMs: 50 });
    try {
      const call = (route: string, method = "GET") =>
        fetch(`http://127.0.0.1:${hub.port}${route}`, { method, headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json() as Promise<any>);
      await call("/api/projects/shop/deploy", "POST");
      const deadline = Date.now() + 10_000;
      let last: any;
      while (Date.now() < deadline && last?.state !== "succeeded" && last?.state !== "failed") {
        await new Promise((r) => setTimeout(r, 50));
        last = (await call("/api/projects/shop")).deploy.last;
      }
      assert.equal(last?.state, "succeeded", JSON.stringify(last));
      assert.equal(last.output, `${git(repo, "rev-parse", "--short=7", "HEAD")}\n`);
      assert.equal(readFileSync(marker, "utf8"), "v1\n", "the command ran in the export of main");
    } finally {
      runner.stop();
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
