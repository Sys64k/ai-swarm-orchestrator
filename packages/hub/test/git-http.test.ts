import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { checkPushPolicy, parseReceivePackCommands } from "@aso/hub";
import { gitBasicAuthConfig } from "@aso/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TOKEN, git, gitAsync, pushTaskBranch, tempDir, withHub, writeFiles } from "./helpers.ts";

const A = "a".repeat(40);
const Z = "0".repeat(40);

function pkt(line: string): string {
  return (line.length + 4).toString(16).padStart(4, "0") + line;
}

async function pushFails(cwd: string, ...args: string[]): Promise<string> {
  try {
    await gitAsync(cwd, "push", ...args);
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
  assert.fail(`expected git push ${args.join(" ")} to be rejected`);
}

describe("receive-pack policy", () => {
  it("parses ref-update commands up to the flush packet", () => {
    const body = Buffer.from(pkt(`${Z} ${A} refs/heads/task/x\0report-status side-band-64k\n`) + pkt(`${A} ${A} refs/heads/task/y\n`) + "0000PACK...");
    assert.deepEqual(parseReceivePackCommands(body), [
      { oldSha: Z, newSha: A, ref: "refs/heads/task/x" },
      { oldSha: A, newSha: A, ref: "refs/heads/task/y" },
    ]);
    assert.throws(() => parseReceivePackCommands(Buffer.from(pkt(`${Z} ${A} refs/heads/x\n`))), /flush/);
  });

  it("allows only creating or updating task branches", () => {
    assert.equal(checkPushPolicy([{ oldSha: Z, newSha: A, ref: "refs/heads/task/add-login" }]), undefined);
    assert.match(checkPushPolicy([{ oldSha: A, newSha: A, ref: "refs/heads/main" }])!, /not allowed/);
    assert.match(checkPushPolicy([{ oldSha: Z, newSha: A, ref: "refs/tags/v1" }])!, /not allowed/);
    assert.match(checkPushPolicy([{ oldSha: Z, newSha: A, ref: "refs/heads/task/../main" }])!, /not allowed/);
    assert.match(checkPushPolicy([{ oldSha: A, newSha: Z, ref: "refs/heads/task/x" }])!, /deleting/);
    assert.match(
      checkPushPolicy([
        { oldSha: Z, newSha: A, ref: "refs/heads/task/ok" },
        { oldSha: A, newSha: A, ref: "refs/heads/main" },
      ])!,
      /main/,
    );
  });
});

describe("Hub git endpoint", () => {
  it("authenticates with a token from a config file, not the command line (as the Hub reaches GitHub)", () =>
    withHub(async (ctx) => {
      const url = `http://127.0.0.1:${ctx.port}/git/project.git`;
      const lsRemote = (config: string[]) =>
        promisify(execFile)("git", [...config, "ls-remote", "--heads", url], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      const entry = gitBasicAuthConfig(url, TOKEN)!;
      assert.match((await lsRemote(["-c", entry])).stdout, /refs\/heads\/main/);
      await assert.rejects(lsRemote([]), "the endpoint needs the token");
      await assert.rejects(lsRemote(["-c", gitBasicAuthConfig(url, "wrong-token")!]));
    }));

  it("serves clones and accepts task branch pushes", () =>
    withHub(async ({ gitUrl, repoDir }) => {
      const commit = await pushTaskBranch(gitUrl, "feat-1", { "src/a.ts": "export {};\n" });
      assert.equal(git(repoDir, "rev-parse", "task/feat-1"), commit);
      assert.equal(git(repoDir, "status", "--porcelain"), "", "pushes must not touch the Hub checkout");
    }));

  it("rejects pushes to main, tags and deletions", () =>
    withHub(async ({ gitUrl, repoDir }) => {
      await pushTaskBranch(gitUrl, "keep", { "a.txt": "a\n" });
      const before = git(repoDir, "rev-parse", "main");
      const dir = tempDir("aso-clone-");
      try {
        await gitAsync(dir, "clone", "--quiet", gitUrl, ".");
        writeFiles(dir, { "evil.txt": "x\n" });
        git(dir, "add", "-A");
        git(dir, "commit", "--quiet", "-m", "evil");
        assert.match(await pushFails(dir, "origin", "HEAD:main"), /403/);
        git(dir, "tag", "v1");
        assert.match(await pushFails(dir, "origin", "v1"), /403/);
        assert.match(await pushFails(dir, "origin", "--delete", "task/keep"), /403/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      assert.equal(git(repoDir, "rev-parse", "main"), before);
      assert.ok(git(repoDir, "rev-parse", "task/keep"));
    }));

  it("does not expose arbitrary paths", () =>
    withHub(async ({ port }) => {
      for (const p of ["/git/project.git/config", "/git/project.git/objects/info/packs", "/git/project.git/../../etc/passwd"]) {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        assert.equal(res.status, 404, p);
      }
    }));
});
