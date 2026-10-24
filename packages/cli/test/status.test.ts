import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startHub } from "@aso/hub";
import type { ApiNode, ApiProject } from "@aso/shared";
import { shortCommit } from "@aso/shared";
import { deployCommand, deployEnded, deployLine, hubLine, projectLine, statusCommand, workerLine } from "../dist/commands/status.js";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API
process.env.ASO_LOG_LEVEL ??= "error"; // the test Hub logs through console, which these tests read

const SHA = "a18d17b".padEnd(40, "0");

describe("aso status lines", () => {
  it("says what the Hub runs and where its update stands", () => {
    const u = { current: "0.1.0+a914b89", target: "5147fe7".padEnd(40, "1") };
    assert.equal(shortCommit("0.1.0+a914b89"), "a914b89");
    assert.equal(hubLine({ ...u, state: "off" }), "Hub 0.1.0+a914b89 (doesn't update itself)");
    assert.equal(hubLine({ ...u, state: "current" }), "Hub 0.1.0+a914b89, up to date with its repository");
    assert.equal(hubLine({ ...u, state: "building" }), "Hub 0.1.0+a914b89, building and testing 5147fe7");
    assert.match(hubLine({ ...u, state: "waiting" }), /5147fe7 is ready: waiting until no task/);
    assert.equal(hubLine({ ...u, state: "failed", error: "build or tests failed" }), "Hub 0.1.0+a914b89, update to 5147fe7 failed: build or tests failed");
    assert.equal(hubLine({ current: "0.1.0+a914b89", state: "failed", error: "could not read the repository's main" }), "Hub 0.1.0+a914b89, update failed: could not read the repository's main");
  });

  it("sums up a worker and a project with its deploy", () => {
    const node = { nodeId: "avalon-1", nodeKind: "worker", hardware: { hostname: "avalon" }, currentTaskIds: ["t1"], slots: 4, draining: false, outdated: false, version: "0.1.0+a" } as unknown as ApiNode;
    assert.equal(workerLine(node), "avalon: working (1 of 4 jobs)");
    assert.equal(workerLine({ ...node, currentTaskIds: [], draining: true }), "avalon: draining");
    assert.equal(workerLine({ ...node, currentTaskIds: [], outdated: true }), "avalon: idle, runs 0.1.0+a (updates when idle)");

    assert.equal(deployLine({ configured: false }), undefined);
    assert.equal(deployLine({ configured: true }), "no deploy since the Hub started");
    assert.equal(deployLine({ configured: true, last: { state: "running", commit: SHA, startedAt: "2026-10-24T10:00:00Z" } }), "deploying a18d17b");
    assert.equal(
      deployLine({ configured: true, last: { state: "failed", commit: SHA, startedAt: "2026-10-24T10:00:00Z", finishedAt: "2026-10-24T10:01:12Z", error: "exited with code 1" } }),
      "deploy of a18d17b failed in 1 min 12 s: exited with code 1",
    );
    assert.equal(
      deployLine({ configured: true, last: { state: "succeeded", commit: SHA, startedAt: "2026-10-24T10:00:00Z", finishedAt: "2026-10-24T10:00:00.300Z" } }),
      "deployed a18d17b in less than a second",
    );
    const project = {
      id: "shop",
      tasks: { total: 5, running: 1, queued: 2, reviewing: 0, failed: 0, merged: 2 },
      plansAwaitingApproval: 1,
      deploy: { configured: true, last: { state: "succeeded", commit: SHA, startedAt: "2026-10-24T10:00:00Z", finishedAt: "2026-10-24T10:00:27Z" } },
    } as unknown as ApiProject;
    assert.equal(projectLine(project), "shop: 1 running, 2 queued; 1 plan(s) to approve; deployed a18d17b in 27 s");
    assert.equal(projectLine({ ...project, tasks: { ...project.tasks, running: 0, queued: 0 }, plansAwaitingApproval: 0, deploy: { configured: false } }), "shop: no work in progress");
  });

  it("waits for the deploy started after the request, not the one before", () => {
    const before = { state: "succeeded" as const, commit: SHA, startedAt: "2026-10-24T10:00:00Z" };
    assert.equal(deployEnded(before, before), false);
    assert.equal(deployEnded(before, { ...before, state: "running", startedAt: "2026-10-24T10:05:00Z" }), false);
    assert.equal(deployEnded(before, { ...before, state: "failed", startedAt: "2026-10-24T10:05:00Z" }), true);
    assert.equal(deployEnded(undefined, { ...before, state: "succeeded" }), true);
    assert.equal(deployEnded(before, { ...before, state: "failed", startedAt: "2026-10-24T10:00:00.000Z" }), false, "the same time written another way");
  });
});

describe("aso status and aso deploy against a Hub", () => {
  /** A Hub with project `shop` whose deploy command is `command`; `out` collects what the CLI prints. */
  async function hubWith(command: string) {
    const root = path.join(os.tmpdir(), `aso-status-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const repo = path.join(root, "shop");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "first"], { cwd: repo });
    const token = "test-token-status-cli";
    const hub = await startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token, sync: { enabled: false } });
    mkdirSync(path.join(root, ".aso"), { recursive: true });
    writeFileSync(path.join(root, ".aso", "deploy.json"), JSON.stringify({ shop: { command } }));
    const saved = { token: process.env.ASO_TOKEN, log: console.log, error: console.error, exitCode: process.exitCode };
    process.env.ASO_TOKEN = token;
    const out: string[] = [];
    console.log = (...a: unknown[]) => void out.push(a.join(" "));
    console.error = (...a: unknown[]) => void out.push(a.join(" "));
    const restore = async () => {
      Object.assign(console, { log: saved.log, error: saved.error });
      process.env.ASO_TOKEN = saved.token;
      process.exitCode = saved.exitCode;
      await hub.close();
      rmSync(root, { recursive: true, force: true });
    };
    return { address: `127.0.0.1:${hub.port}`, out, restore };
  }

  it("deploys and follows it to the end, then status shows it", async () => {
    const h = await hubWith("sleep 0.3; echo shipped");
    try {
      await deployCommand("shop", { hub: h.address, wait: true });
      const exit = process.exitCode;
      await statusCommand({ hub: h.address });
      const text = h.out.join("\n");
      h.out.length = 0;
      await h.restore();
      assert.equal(exit ?? 0, 0);
      assert.match(text, /shop: deploying…\nshop: deployed [0-9a-f]{7} in (less than a second|\d+ s)/);
      assert.match(text, /Hub \S+ \(doesn't update itself\)/);
      assert.match(text, /Workers \(0\): none connected/);
      assert.match(text, /  shop: no work in progress; deployed [0-9a-f]{7}/);
    } catch (err) {
      await h.restore();
      throw err;
    }
  });

  it("fails with the reason and the end of the output when the deploy fails", async () => {
    const h = await hubWith("echo building; echo 'npm error boom' >&2; exit 3");
    try {
      await deployCommand("shop", { hub: h.address, wait: true });
      const exit = process.exitCode;
      const text = h.out.join("\n");
      await h.restore();
      assert.equal(exit, 1);
      assert.match(text, /shop: deploy of [0-9a-f]{7} failed in (less than a second|\d+ s): exited with code 3/);
      assert.match(text, /Last lines of its output:\nbuilding\nnpm error boom/);
    } catch (err) {
      await h.restore();
      throw err;
    }
  });

  it("says why a project can't be deployed", async () => {
    const h = await hubWith("true");
    try {
      await assert.rejects(deployCommand("nope", { hub: h.address, wait: true }), /not found/);
    } finally {
      await h.restore();
    }
  });
});
