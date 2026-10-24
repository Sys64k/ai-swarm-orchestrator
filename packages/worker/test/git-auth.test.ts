import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { authConfigFile, authConfigText } from "../dist/git/auth-config.js";

describe("the worker's Git credential", () => {
  it("writes the header as one quoted value, whatever the token holds", () => {
    assert.equal(authConfigText("asow_abc-_123"), '[http]\n\textraHeader = "Authorization: Bearer asow_abc-_123"\n');
    assert.equal(authConfigText('a"b\\c'), '[http]\n\textraHeader = "Authorization: Bearer a\\"b\\\\c"\n');
    assert.throws(() => authConfigText("asow_x\n[core]\n\tsshCommand = evil"), /control character/);
    assert.throws(() => authConfigText("asow_x\u0000"), /control character/);
  });

  it("keeps the token in an owner-only file that git reads, not in its arguments or .git/config", () => {
    const file = authConfigFile("asow_secret-token");
    assert.equal(authConfigFile("asow_secret-token"), file, "one file per token");
    assert.notEqual(authConfigFile("asow_other"), file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.match(readFileSync(file, "utf8"), /asow_secret-token/);

    const repo = mkdtempSync(path.join(os.tmpdir(), "aso-auth-repo-"));
    try {
      execFileSync("git", ["init", "--quiet", repo]);
      const args = ["-C", repo, "-c", `include.path=${file}`, "config", "--get", "http.extraHeader"];
      assert.equal(execFileSync("git", args, { encoding: "utf8" }).trim(), "Authorization: Bearer asow_secret-token");
      assert.ok(!args.join(" ").includes("asow_secret-token"), "only the file's path is on the command line");
      assert.throws(() => execFileSync("git", ["-C", repo, "config", "--local", "--get", "http.extraHeader"], { stdio: "pipe" }), "nothing stored in the checkout");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
