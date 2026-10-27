import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { startHub } from "@aso/hub";
import type { Exec } from "../dist/exec.js";
import { HubVersions } from "../dist/hub-versions.js";
import { buildEnv, HubUpdater, isBuildOf, isDocumentation, onlyDocumentation, rollbackUnconfirmed, swarmIdle, type UpdatePaths } from "../dist/self-update.js";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const TOKEN = "test-token-self-update";
const RUNNING = "0.1.0+aaaaaaa";
const NEWER = "bbbbbbb".padEnd(40, "1");
const NEW_VERSION = "0.1.0+bbbbbbb";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A fake package install: what `npm install --prefix <dir> ... <tarball>` leaves. */
function fakeInstall(prefix: string, label: string) {
  const dist = path.join(prefix, "node_modules", "aso-cli", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "aso.mjs"), label);
}

interface SetupOptions {
  /** What `git ls-remote` answers, in turn (the last one repeats). */
  remote?: string[];
  failTests?: boolean;
  deploy?: string;
  packageVersion?: string;
  /** The version the Hub says it runs. */
  hubVersion?: string;
  watchdogFails?: boolean;
  /** The restart never happens: the updater notices after a short grace. */
  restartFails?: boolean;
  /** `git ls-remote` fails. */
  remoteFails?: boolean;
  /** What `git diff --name-only` lists between the running version and main. */
  changed?: string[];
}

/** A Hub with one project, an installed running version, and fakes for what the updater runs. */
async function setup(opts: SetupOptions = {}) {
  const root = path.join(os.tmpdir(), `aso-update-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const repo = path.join(root, "projects", "shop");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "first");
  const paths: UpdatePaths = { versions: path.join(root, "hub"), state: path.join(root, "hub", "update"), work: path.join(root, "work") };
  const versions = new HubVersions(paths.versions);
  const runningDir = versions.dirOf(RUNNING);
  fakeInstall(runningDir, "the running version");
  await versions.switchTo(runningDir);

  const hubVersion = opts.hubVersion ?? RUNNING;
  const hub = await startHub({
    projectsRoot: path.join(root, "projects"),
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    sync: { enabled: false },
    dist: { version: () => hubVersion, tarball: () => undefined },
  });
  if (opts.deploy) {
    // After the start, which deploys every project: the test's deploy is then the only one.
    mkdirSync(path.join(root, "projects", ".aso"), { recursive: true });
    writeFileSync(path.join(root, "projects", ".aso", "deploy.json"), JSON.stringify({ shop: { command: opts.deploy } }));
  }
  const calls: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const watchdogs: Array<{ entry: string; deadlineSec: number; id: string }> = [];
  let restarts = 0;
  const remotes = [...(opts.remote ?? [NEWER])];
  const exec: Exec = async (cmd, args, o = {}) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    if (o.env) envs.push(o.env);
    if (line.startsWith("git ls-remote") && opts.remoteFails) throw new Error("`git ls-remote` exited with code 128: Permission denied (publickey)");
    if (line.startsWith("git ls-remote")) return `${remotes.length > 1 ? remotes.shift() : remotes[0]}\trefs/heads/main\n`;
    if (line.startsWith("git clone")) mkdirSync(path.join(args.at(-1)!, ".git"), { recursive: true });
    if (line.startsWith("git diff --name-only")) return (opts.changed ?? ["packages/hub/src/server.ts"]).join("\n");
    if (line === "npm test" && opts.failTests) throw new Error("`npm test` exited with code 1: 1 failing");
    if (line === "npm run package") {
      mkdirSync(path.join(o.cwd!, "release"), { recursive: true });
      writeFileSync(path.join(o.cwd!, "release", "aso.json"), JSON.stringify({ version: opts.packageVersion ?? `0.1.0+${o.env?.ASO_BUILD}` }));
      writeFileSync(path.join(o.cwd!, "release", "aso.tgz"), "the new package");
    }
    if (line.startsWith("npm install --prefix")) fakeInstall(args[2], readFileSync(args.at(-1)!, "utf8"));
    return "";
  };
  const updater = (current = RUNNING) =>
    new HubUpdater({
      hubUrl: `http://127.0.0.1:${hub.port}`,
      token: TOKEN,
      repo: "https://example.com/aso.git",
      paths,
      current,
      exec,
      armWatchdog: async (entry, deadlineSec, id) => {
        if (opts.watchdogFails) throw new Error("systemd-run failed: no user bus");
        watchdogs.push({ entry, deadlineSec, id });
      },
      restart: () => {
        restarts++;
      },
      // A restart stops the process, which a test can't: check() then never returns, as in a real
      // restart, and the test looks at the state it left. With restartFails the grace is short.
      restartGraceMs: opts.restartFails ? 50 : 10 * 60_000,
      idlePollMs: 50,
      stableMs: 200,
    });
  const call = (route: string, method = "GET") =>
    fetch(`http://127.0.0.1:${hub.port}${route}`, { method, headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json() as Promise<any>);
  const status = () => call("/api/hub/update");
  const pending = () => (existsSync(path.join(paths.state, "pending.json")) ? JSON.parse(readFileSync(path.join(paths.state, "pending.json"), "utf8")) : undefined);
  const current = () => readlinkSync(path.join(paths.versions, "current"));
  const cleanup = async () => {
    await hub.close();
    rmSync(root, { recursive: true, force: true });
  };
  /** A pass that switches: in a real restart, check() never returns, so wait for the restart or its end. */
  const checkUntilRestart = async () => {
    const done = updater().check();
    let finished = false;
    void done.then(() => (finished = true));
    while (restarts === 0 && !finished) await new Promise((r) => setTimeout(r, 10));
  };
  return { checkUntilRestart, hub, paths, versions, runningDir, calls, envs, watchdogs, restarts: () => restarts, updater, call, status, pending, current, cleanup };
}

const LS_REMOTE = "git ls-remote https://example.com/aso.git refs/heads/main";

/** What a switch to NEW_VERSION in `toDir` leaves, with its deadline `inMs` from now. */
function pendingFor(s: { runningDir: string }, toDir: string, inMs = 900_000) {
  return { id: "update-1", from: RUNNING, fromDir: s.runningDir, to: NEW_VERSION, toDir, target: NEWER, deadline: new Date(Date.now() + inMs).toISOString() };
}

describe("the Hub's own update", () => {
  it("does nothing while the Hub runs the repository's main", async () => {
    const s = await setup({ remote: ["aaaaaaa".padEnd(40, "0")] });
    try {
      assert.equal((await s.status()).state, "off");
      await s.updater().check();
      assert.deepEqual(s.calls, [LS_REMOTE]);
      assert.equal((await s.status()).state, "current");
    } finally {
      await s.cleanup();
    }
  });

  it("builds and tests a newer main, installs it beside the running one, waits for the running deploy, arms the watchdog and switches", async () => {
    const s = await setup({ deploy: "sleep 0.5" });
    try {
      await s.call("/api/projects/shop/deploy", "POST");
      while ((await s.call("/api/projects/shop")).deploy.last?.state !== "running") await new Promise((r) => setTimeout(r, 10));
      await s.checkUntilRestart();
      assert.deepEqual(s.calls.map((c) => c.split(" ").slice(0, 2).join(" ")), [
        "git ls-remote",
        "git clone",
        "git fetch",
        "git diff", // what changed: code, so it's built
        "git checkout",
        "git clean",
        "npm ci",
        "npm test",
        "npm run",
        "npm install",
        "git ls-remote", // main hasn't moved while it waited
      ]);
      assert.ok(s.calls.includes(`git checkout --quiet --force --detach ${NEWER}`));
      assert.equal((await s.call("/api/projects/shop")).deploy.last.state, "succeeded", "the switch waited for the deploy");
      const newDir = s.versions.dirOf(NEW_VERSION);
      assert.equal(readFileSync(s.versions.entry(newDir), "utf8"), "the new package");
      assert.equal(s.current(), newDir, "current points at the new version");
      assert.equal(readFileSync(s.versions.entry(s.runningDir), "utf8"), "the running version", "the running version is untouched");
      const { id, deadline, ...pending } = s.pending();
      assert.deepEqual(s.watchdogs, [{ entry: s.versions.entry(s.runningDir), deadlineSec: 900, id }], "the known good version watches this update");
      assert.deepEqual(pending, { from: RUNNING, fromDir: s.runningDir, to: NEW_VERSION, toDir: newDir, target: NEWER });
      assert.ok(Math.abs(Date.parse(deadline) - (Date.now() + 900_000)) < 10_000);
      assert.equal(readlinkSync(path.join(s.paths.versions, "previous")), s.runningDir, "the start-time check runs the previous version");
      assert.equal(s.restarts(), 1);
      assert.deepEqual(await s.status().then(({ state, target }) => ({ state, target })), { state: "restarting", target: NEWER });
    } finally {
      await s.cleanup();
    }
  });

  it("gives npm its own home and none of the Hub's secrets, and git the Hub's own environment", async () => {
    process.env.ASO_GIT_TOKEN = "secret-git-token";
    const s = await setup();
    try {
      await s.checkUntilRestart();
      assert.equal(s.envs.length, 3, "npm ci, npm test and npm run package; git runs with the Hub's own");
      for (const env of s.envs) {
        assert.equal(env.HOME, path.join(s.paths.work, "home"));
        assert.equal(env.ASO_GIT_TOKEN, undefined);
        assert.equal(env.DOCKER_HOST, undefined);
      }
    } finally {
      delete process.env.ASO_GIT_TOKEN;
      await s.cleanup();
    }
  });

  it("leaves the Hub alone when main moved while it waited (the next pass takes the newer commit)", async () => {
    const s = await setup({ remote: [NEWER, "c".repeat(40)] });
    try {
      await s.updater().check();
      assert.equal(s.current(), s.runningDir);
      assert.equal(s.pending(), undefined);
      assert.deepEqual(s.watchdogs, []);
      assert.equal(s.restarts(), 0);
    } finally {
      await s.cleanup();
    }
  });

  it("tries a commit whose tests fail a few times, then no more", async () => {
    const s = await setup({ failTests: true });
    try {
      for (let i = 0; i < 3; i++) await s.updater().check();
      const status = await s.status();
      assert.equal(status.state, "failed");
      assert.match(status.error, /build or tests failed: `npm test` exited with code 1: 1 failing/);
      assert.equal(s.calls.filter((c) => c === "npm test").length, 3);
      s.calls.length = 0;
      await s.updater().check();
      assert.deepEqual(s.calls, [LS_REMOTE], "given up");
      assert.equal(s.current(), s.runningDir);
    } finally {
      await s.cleanup();
    }
  });

  it("refuses a package that isn't named after the commit, so it can't loop", async () => {
    const s = await setup({ packageVersion: "0.1.0+bbbbbbb-dirty" });
    try {
      await s.updater().check();
      const status = await s.status();
      assert.equal(status.state, "failed");
      assert.match(status.error, /the package is 0\.1\.0\+bbbbbbb-dirty, not a build of bbbbbbb/);
      assert.equal(s.current(), s.runningDir);
    } finally {
      await s.cleanup();
    }
  });

  it("doesn't switch when the watchdog can't be armed", async () => {
    const s = await setup({ watchdogFails: true });
    try {
      await s.updater().check();
      assert.equal(s.current(), s.runningDir);
      assert.equal(s.pending(), undefined);
      assert.equal(s.restarts(), 0);
      assert.match((await s.status()).error, /could not arm the rollback watchdog, so it was not installed: systemd-run failed/);
    } finally {
      await s.cleanup();
    }
  });

  it("confirms an update once the Hub has answered as the new version for a while, and keeps only the two versions", async () => {
    const s = await setup({ hubVersion: NEW_VERSION });
    try {
      const newDir = s.versions.dirOf(NEW_VERSION);
      fakeInstall(newDir, "the new package");
      fakeInstall(s.versions.dirOf("0.1.0+0000000"), "an old one");
      await s.versions.switchTo(newDir);
      mkdirSync(s.paths.state, { recursive: true });
      writeFileSync(path.join(s.paths.state, "pending.json"), JSON.stringify(pendingFor(s, newDir)));
      await s.updater(NEW_VERSION).afterStart();
      assert.deepEqual(await s.status().then(({ state, current }) => ({ state, current })), { state: "updated", current: NEW_VERSION });
      assert.equal(s.pending(), undefined);
      assert.equal(existsSync(s.versions.dirOf("0.1.0+0000000")), false, "pruned");
      assert.ok(existsSync(s.runningDir), "the previous version is kept");
    } finally {
      await s.cleanup();
    }
  });

  it("does not confirm while another version answers (the watchdog then decides)", async () => {
    const s = await setup({ hubVersion: RUNNING }); // e.g. the old container still holds the port
    try {
      mkdirSync(s.paths.state, { recursive: true });
      writeFileSync(path.join(s.paths.state, "pending.json"), JSON.stringify(pendingFor(s, "x")));
      const updater = s.updater(NEW_VERSION);
      const confirming = updater.afterStart();
      await new Promise((r) => setTimeout(r, 600));
      updater.stop();
      await confirming;
      assert.notEqual(s.pending(), undefined);
      assert.equal((await s.status()).state, "off");
    } finally {
      await s.cleanup();
    }
  });

  it("the watchdog puts the previous version back when the update never confirmed, and it reports that once up", async () => {
    const s = await setup({ remote: [NEWER] });
    try {
      const newDir = s.versions.dirOf(NEW_VERSION);
      fakeInstall(newDir, "the new package");
      await s.versions.switchTo(newDir);
      mkdirSync(s.paths.state, { recursive: true });
      writeFileSync(path.join(s.paths.state, "pending.json"), JSON.stringify(pendingFor(s, newDir)));
      let restarted = 0;
      assert.equal(await rollbackUnconfirmed(s.paths, { id: "update-1" }, () => restarted++), true);
      assert.equal(s.current(), s.runningDir);
      assert.equal(restarted, 1);
      assert.equal(s.pending(), undefined);

      const restored = s.updater(RUNNING);
      await restored.afterStart();
      const status = await s.status();
      assert.equal(status.state, "failed");
      assert.equal(status.target, NEWER);
      assert.match(status.error, /0\.1\.0\+bbbbbbb did not come up and answer as itself within 15 min, so 0\.1\.0\+aaaaaaa was put back/);
      assert.equal(existsSync(path.join(s.paths.state, "rolled-back.json")), false, "reported once");
      s.calls.length = 0;
      await restored.check();
      assert.deepEqual(s.calls, [LS_REMOTE], "the commit that didn't come up is never tried again");
      assert.equal(await rollbackUnconfirmed(s.paths, { id: "update-1" }, () => restarted++), false, "nothing pending: nothing to do");
      assert.equal(restarted, 1);
    } finally {
      await s.cleanup();
    }
  });
});

describe("the update watchdog", () => {
  /** A switched update to NEW_VERSION, pending with a deadline `inMs` from now. */
  async function switched(inMs = 900_000) {
    const s = await setup();
    const newDir = s.versions.dirOf(NEW_VERSION);
    fakeInstall(newDir, "the new package");
    await s.versions.switchTo(newDir);
    mkdirSync(s.paths.state, { recursive: true });
    writeFileSync(path.join(s.paths.state, "pending.json"), JSON.stringify(pendingFor(s, newDir, inMs)));
    return { ...s, newDir };
  }

  it("leaves a later update to its own watchdog", async () => {
    const s = await switched();
    try {
      let restarted = 0;
      assert.equal(await rollbackUnconfirmed(s.paths, { id: "an-earlier-update" }, () => restarted++), false);
      assert.equal(s.current(), s.newDir);
      assert.notEqual(s.pending(), undefined);
      assert.equal(restarted, 0);
    } finally {
      await s.cleanup();
    }
  });

  it("doesn't blame a commit whose switch never happened", async () => {
    const s = await switched();
    try {
      await s.versions.switchTo(s.runningDir); // killed before the switch, or it was undone
      let restarted = 0;
      assert.equal(await rollbackUnconfirmed(s.paths, { id: "update-1" }, () => restarted++), false);
      assert.equal(s.pending(), undefined);
      assert.equal(restarted, 0, "the running version is left alone");
      assert.equal(existsSync(path.join(s.paths.state, "failed.json")), false);
    } finally {
      await s.cleanup();
    }
  });

  it("at a start, rolls back only an update past its deadline (e.g. after a reboot), without restarting", async () => {
    const early = await switched();
    try {
      assert.equal(await rollbackUnconfirmed(early.paths, { atStart: true }, () => assert.fail("no restart at a start")), false);
      assert.equal(early.current(), early.newDir, "it still has time");
    } finally {
      await early.cleanup();
    }
    const late = await switched(-1000);
    try {
      assert.equal(await rollbackUnconfirmed(late.paths, { atStart: true }, () => assert.fail("no restart at a start")), true);
      assert.equal(late.current(), late.runningDir, "the start that follows runs the previous version");
      assert.equal(late.pending(), undefined);
    } finally {
      await late.cleanup();
    }
  });

  it("undoes the switch when the service can't be restarted", async () => {
    const s = await setup({ restartFails: true });
    try {
      await s.updater().check();
      assert.equal(s.current(), s.runningDir);
      assert.equal(s.pending(), undefined, "the armed watchdog finds nothing to do");
      assert.match((await s.status()).error, /could not be restarted onto it/);
    } finally {
      await s.cleanup();
    }
  });

  it("reuses a build already installed for the commit", async () => {
    const s = await setup();
    try {
      fakeInstall(s.versions.dirOf(NEW_VERSION), "built on an earlier pass");
      await s.checkUntilRestart();
      assert.deepEqual(
        s.calls.filter((c) => !/^git (clone|fetch|diff) /.test(c)),
        [LS_REMOTE, LS_REMOTE],
        "no build, only the re-check after waiting",
      );
      assert.equal(s.current(), s.versions.dirOf(NEW_VERSION));
    } finally {
      await s.cleanup();
    }
  });

  it("stays as it is when main changed only documentation, and builds once code changes too", async () => {
    const s = await setup({ changed: ["README.md", "docs/models.md", ".github/workflows/swarm-stats.yml"] });
    try {
      const updater = s.updater();
      await updater.check();
      await updater.check();
      assert.ok(!s.calls.some((c) => /^(npm|git checkout)/.test(c)), "nothing built");
      assert.equal(s.calls.filter((c) => c.startsWith("git diff")).length, 1, "asked once for that commit");
      assert.equal((await s.status()).state, "current");
      assert.equal(s.restarts(), 0);
    } finally {
      await s.cleanup();
    }
    const withCode = await setup({ changed: ["README.md", "packages/hub/src/server.ts"] });
    try {
      await withCode.checkUntilRestart();
      assert.ok(withCode.calls.includes("npm test"), "built");
    } finally {
      await withCode.cleanup();
    }
  });

  it("tells documentation from what a Hub is built of", () => {
    for (const f of ["README.md", "docs/cli.md", "ARCHITECTURE.md", "packages/hub/README.md", "docs/images/x.png", ".github/workflows/a.yml", "LICENSE"]) assert.ok(isDocumentation(f), f);
    for (const f of ["docs/openapi.json", "packages/hub/src/server.ts", "package.json", "docker-compose.yml", "scripts/package.mjs"]) assert.ok(!isDocumentation(f), f);
    assert.equal(onlyDocumentation([]), false, "nothing changed isn't documentation only");
    assert.equal(onlyDocumentation(["README.md", "package.json"]), false);
  });

  it("reports when the repository can't be read", async () => {
    const s = await setup({ remoteFails: true });
    try {
      await s.updater().check();
      const status = await s.status();
      assert.equal(status.state, "failed");
      assert.match(status.error, /could not read the repository's main: .*Permission denied/);
    } finally {
      await s.cleanup();
    }
  });
});

describe("update helpers", () => {
  it("matches a version to the commit it was built from", () => {
    assert.equal(isBuildOf("0.1.0+840bcd7", "840bcd7a1b2c3d4e5f60718293a4b5c6d7e8f901"), true);
    assert.equal(isBuildOf("0.1.0+840bcd7", "940bcd7a1b2c3d4e5f60718293a4b5c6d7e8f901"), false);
    assert.equal(isBuildOf("0.1.0+840bcd7-dirty", "840bcd7a1b2c3d4e5f60718293a4b5c6d7e8f901"), false, "a dirty build is never main");
    assert.equal(isBuildOf("0.1.0", "840bcd7a1b2c3d4e5f60718293a4b5c6d7e8f901"), false);
  });

  it("calls the swarm idle only with no task at work, no deploy running and no plan being made", () => {
    assert.equal(swarmIdle([{ state: "merged" }, { state: "pending" }, { state: "awaiting_review" }], [{ deploy: { last: { state: "succeeded" } } }, {}], [{ state: "proposed" }]), true);
    for (const state of ["assigned", "in_progress", "verifying", "awaiting_qa", "testing", "merging"] as const) assert.equal(swarmIdle([{ state }], [], []), false, state);
    assert.equal(swarmIdle([], [{ deploy: { last: { state: "running" } } }], []), false);
    assert.equal(swarmIdle([], [], [{ state: "planning" }]), false);
  });

  it("builds with its own home and only a few of the Hub's variables", () => {
    const env = buildEnv("/w/home", { PATH: "/bin", HOME: "/home/me", ANTHROPIC_API_KEY: "k", ASO_TOKEN: "t", DOCKER_HOST: "unix:///x", LANG: "C" });
    assert.deepEqual(env, {
      PATH: "/bin",
      LANG: "C",
      HOME: "/w/home",
      XDG_CONFIG_HOME: "/w/home/.config",
      XDG_CACHE_HOME: "/w/home/.cache",
      XDG_DATA_HOME: "/w/home/.local/share",
      CI: "1",
    });
  });
});
