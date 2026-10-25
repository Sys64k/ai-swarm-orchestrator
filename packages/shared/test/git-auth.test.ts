import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { gitBasicAuthConfig, gitHeaderConfigFile, gitHeaderConfigText } from "@aso/shared";

/** What `git config --get-urlmatch` says the header is for `url`, with `-c <entry>`. */
function headerFor(entry: string, url: string): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aso-auth-repo-"));
  try {
    execFileSync("git", ["init", "--quiet", repo]);
    try {
      return execFileSync("git", ["-C", repo, "-c", entry, "config", "--get-urlmatch", "http.extraHeader", url], { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("Git credentials from an owner-only file", () => {
  it("writes the header as one quoted value, whatever it holds", () => {
    assert.equal(gitHeaderConfigText("Authorization: Bearer asow_abc-_123"), '[http]\n\textraHeader = "Authorization: Bearer asow_abc-_123"\n');
    assert.equal(gitHeaderConfigText('Authorization: Bearer a"b\\c'), '[http]\n\textraHeader = "Authorization: Bearer a\\"b\\\\c"\n');
    assert.equal(gitHeaderConfigText("X: y", "https://github.com/"), '[http "https://github.com/"]\n\textraHeader = "X: y"\n');
    assert.throws(() => gitHeaderConfigText("Authorization: Bearer x\n[core]\n\tsshCommand = evil"), /control character/);
    assert.throws(() => gitHeaderConfigText("Authorization: Bearer x\u0000"), /control character/);
  });

  it("keeps the credential in a private file git reads, not in its arguments", () => {
    const file = gitHeaderConfigFile("Authorization: Bearer asow_secret-token");
    assert.equal(gitHeaderConfigFile("Authorization: Bearer asow_secret-token"), file, "one file per header");
    assert.notEqual(gitHeaderConfigFile("Authorization: Bearer asow_other"), file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.match(readFileSync(file, "utf8"), /asow_secret-token/);
    assert.equal(headerFor(`include.path=${file}`, "http://hub:7420/git/p.git"), "Authorization: Bearer asow_secret-token");
  });

  it("sends the Hub's GitHub token to the remote's host only", () => {
    const entry = gitBasicAuthConfig("https://github.com/me/app.git", "ghp_secret");
    assert.ok(entry?.startsWith("include.path="));
    assert.ok(!entry.includes("ghp_secret") && !entry.includes(Buffer.from("x-access-token:ghp_secret").toString("base64")), "only a path on the command line");
    const basic = `Authorization: Basic ${Buffer.from("x-access-token:ghp_secret").toString("base64")}`;
    assert.equal(headerFor(entry, "https://github.com/me/app.git"), basic);
    assert.equal(headerFor(entry, "https://example.com/other.git"), "", "never to another host");
    assert.equal(gitBasicAuthConfig("git@github.com:me/app.git", "ghp_secret"), undefined, "SSH remotes get nothing");
  });
});
