import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Deployer, deployEnv, deployNotification, HostDeployQueue, runCommand, type DeployStatus } from "@aso/hub";
import { createMessage } from "@aso/shared";
import { git, makeTargetRepo, postTask, pushTaskBranch, tempDir, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const env = { PATH: process.env.PATH };

describe("runCommand", () => {
  it("reports success, the exit code, and the end of the output", async () => {
    assert.deepEqual(await runCommand("echo out; echo err >&2", { cwd: tempDir(), env, timeoutSec: 10 }), { ok: true, output: "out\nerr\n" });
    const failed = await runCommand("echo nope; exit 3", { cwd: tempDir(), env, timeoutSec: 10 });
    assert.deepEqual(failed, { ok: false, error: "exited with code 3", output: "nope\n" });
    const long = await runCommand("yes x | head -c 50000", { cwd: tempDir(), env, timeoutSec: 10 });
    assert.equal(long.output.length, 20_000, "only the end is kept");
  });

  it("stops the whole command, children included, when it runs too long", async () => {
    const started = Date.now();
    const r = await runCommand("sleep 30 & sleep 30", { cwd: tempDir(), env, timeoutSec: 1 });
    assert.deepEqual([r.ok, r.error], [false, "timed out after 1 s"]);
    assert.ok(Date.now() - started < 10_000);
  });
});

describe("Deployer", () => {
  /** A repository with one commit and a Deployer whose deploy.json is `config`. */
  function setup(config?: unknown) {
    const repoDir = makeTargetRepo({ "app.txt": "v1\n" });
    const dir = tempDir("aso-deploy-");
    const out = tempDir("aso-deploy-out-");
    if (config !== undefined) writeFileSync(path.join(dir, "deploy.json"), typeof config === "string" ? config : JSON.stringify(config));
    const results: Array<{ project: string; status: DeployStatus }> = [];
    const deployer = new Deployer({ dir, onResult: (project, status) => results.push({ project, status: { ...status } }) });
    const head = () => git(repoDir, "rev-parse", "HEAD");
    const target = { id: "shop", dir: repoDir, repo: { mainHead: async () => head() } };
    const cleanup = () => [repoDir, dir, out].forEach((d) => rmSync(d, { recursive: true, force: true }));
    return { repoDir, dir, out, results, deployer, target, head, cleanup };
  }

  it("runs the operator's command in a clean export of main, without the Hub's secrets", async () => {
    process.env.ASO_GIT_TOKEN = "secret-token";
    const s = setup();
    try {
      writeFileSync(path.join(s.dir, "deploy.json"), JSON.stringify({ shop: { command: 'ls -A > "$OUT/files"; env > "$OUT/env"; echo deployed', env: { OUT: s.out } } }));
      await s.deployer.load();
      assert.deepEqual(s.deployer.view("shop"), { configured: true });
      s.deployer.request(s.target);
      const { status } = await waitFor(() => s.results[0]);
      assert.equal(status.state, "succeeded");
      assert.equal(status.commit, s.head());
      assert.equal(status.output, "deployed\n");
      assert.deepEqual(readFileSync(path.join(s.out, "files"), "utf8").split("\n").filter(Boolean).sort(), ["README.md", "app.txt"], "the commit's files, no .git");
      const seen = readFileSync(path.join(s.out, "env"), "utf8");
      assert.match(seen, new RegExp(`^ASO_DEPLOY_COMMIT=${s.head()}$`, "m"));
      assert.match(seen, new RegExp(`^ASO_DEPLOY_SHORT=${s.head().slice(0, 7)}$`, "m"));
      assert.match(seen, /^ASO_DEPLOY_PROJECT=shop$/m);
      assert.doesNotMatch(seen, /secret-token/, "the Hub's tokens stay with the Hub");
      assert.equal(readFileSync(path.join(s.dir, "deploy", "shop.log"), "utf8"), "deployed\n");
      assert.equal(s.deployer.view("shop").last?.state, "succeeded");
    } finally {
      delete process.env.ASO_GIT_TOKEN;
      s.cleanup();
    }
  });

  it("deploys merges that land during a deploy together, once it ends", async () => {
    const s = setup();
    try {
      writeFileSync(path.join(s.dir, "deploy.json"), JSON.stringify({ shop: { command: `sleep 0.3; echo run >> "${path.join(s.out, "runs")}"` } }));
      s.deployer.request(s.target);
      await waitFor(() => s.deployer.view("shop").last?.state === "running");
      git(s.repoDir, "commit", "--quiet", "--allow-empty", "-m", "merged meanwhile");
      s.deployer.request(s.target);
      s.deployer.request(s.target);
      await waitFor(() => s.results.length === 2 && s.results);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(readFileSync(path.join(s.out, "runs"), "utf8"), "run\nrun\n", "one deploy, then one for everything that came meanwhile");
      assert.equal(s.results[1].status.commit, s.head());
    } finally {
      s.cleanup();
    }
  });

  it("skips a commit that is already live unless forced, and retries one that failed", async () => {
    const s = setup();
    try {
      const flag = path.join(s.out, "fail");
      writeFileSync(path.join(s.dir, "deploy.json"), JSON.stringify({ shop: { command: `echo run >> "${path.join(s.out, "runs")}"; test ! -e "${flag}"` } }));
      const runs = () => readFileSync(path.join(s.out, "runs"), "utf8").split("\n").filter(Boolean).length;
      s.deployer.request(s.target);
      await waitFor(() => s.results.length === 1);
      s.deployer.request(s.target); // the same merge, reported again
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(runs(), 1, "already deployed");
      s.deployer.request(s.target, { force: true }); // "Deploy now"
      await waitFor(() => s.results.length === 2);
      assert.equal(runs(), 2);
      writeFileSync(flag, "");
      git(s.repoDir, "commit", "--quiet", "--allow-empty", "-m", "next");
      s.deployer.request(s.target);
      await waitFor(() => s.results.length === 3);
      assert.equal(s.results[2].status.state, "failed");
      rmSync(flag);
      s.deployer.request(s.target); // a failed commit isn't live: deploy it again
      await waitFor(() => s.results.length === 4);
      assert.equal(s.results[3].status.state, "succeeded");
    } finally {
      s.cleanup();
    }
  });

  it("forgets a forced request that deployed nothing", async () => {
    const s = setup();
    try {
      s.deployer.request(s.target, { force: true }); // no command yet
      await new Promise((r) => setTimeout(r, 200));
      writeFileSync(path.join(s.dir, "deploy.json"), JSON.stringify({ shop: { command: `echo run >> "${path.join(s.out, "runs")}"` } }));
      s.deployer.request(s.target);
      await waitFor(() => s.results.length === 1);
      s.deployer.request(s.target);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(readFileSync(path.join(s.out, "runs"), "utf8"), "run\n", "the second, automatic request is not forced");
    } finally {
      s.cleanup();
    }
  });

  it("does nothing for a project without a command, and reports an invalid file or a failing command", async () => {
    const none = setup();
    try {
      none.deployer.request(none.target);
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(none.results, []);
      assert.deepEqual(none.deployer.view("shop"), { configured: false });
    } finally {
      none.cleanup();
    }
    const invalid = setup({ shop: { command: "true" } });
    try {
      await invalid.deployer.load();
      writeFileSync(path.join(invalid.dir, "deploy.json"), JSON.stringify({ shop: { command: "" } })); // a broken edit
      invalid.deployer.request({ ...invalid.target, id: "other" });
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(invalid.results, [], "a project that never deployed hears nothing of it");
      assert.ok(invalid.deployer.configured("shop"), "the last good commands are kept");
      invalid.deployer.request(invalid.target);
      const { status } = await waitFor(() => invalid.results[0]);
      assert.equal(status.state, "failed");
      assert.match(status.error!, /deploy\.json is invalid or unreadable: shop\.command: /);
    } finally {
      invalid.cleanup();
    }
    const broken = setup({ shop: { command: "echo building; echo 'no space left' >&2; exit 1" } });
    try {
      broken.deployer.request(broken.target);
      const { status } = await waitFor(() => broken.results[0]);
      assert.deepEqual([status.state, status.error], ["failed", "exited with code 1"]);
      assert.deepEqual(deployNotification("shop", status), {
        title: "shop: deploy failed",
        body: `${broken.head().slice(0, 7)}: exited with code 1\nbuilding\nno space left`,
        url: "/projects/shop",
        tag: "deploy-shop",
      });
    } finally {
      broken.cleanup();
    }
  });

  it("passes only the allowlisted part of the Hub's environment", () => {
    const hub = { PATH: "/bin", HOME: "/home/u", ASO_GIT_TOKEN: "t", ANTHROPIC_API_KEY: "k", DOCKER_HOST: "unix:///d" };
    assert.deepEqual(deployEnv({ command: "x", env: { PORT: "7422", PATH: "/opt/bin" } }, "shop", "abcdef0123", hub), {
      PATH: "/opt/bin",
      HOME: "/home/u",
      DOCKER_HOST: "unix:///d",
      PORT: "7422",
      ASO_DEPLOY_PROJECT: "shop",
      ASO_DEPLOY_COMMIT: "abcdef0123",
      ASO_DEPLOY_SHORT: "abcdef0",
    });
  });

  it("words the success notification", () => {
    const status: DeployStatus = { state: "succeeded", commit: "d2cbfbd0123", startedAt: "", output: "lots" };
    assert.deepEqual(deployNotification("aso-ui", status), { title: "aso-ui: deployed", body: "d2cbfbd is live.", url: "/projects/aso-ui", tag: "deploy-aso-ui" });
  });
});

describe("HostDeployQueue", () => {
  const job = { project: "shop", commit: "c".repeat(40), command: { command: "true", timeoutSec: 10 } };

  it("hands jobs out oldest first and resolves each with the host's result", async () => {
    const q = new HostDeployQueue();
    assert.equal(q.next(), undefined);
    const first = q.run(job, "/x");
    const second = q.run({ ...job, project: "blog" }, "/y");
    const a = q.next()!;
    const b = q.next()!;
    assert.deepEqual([a.project, b.project], ["shop", "blog"]);
    assert.equal(q.next(), undefined, "each job is taken once");
    assert.equal(q.complete("unknown", { ok: true, output: "" }), false);
    assert.ok(q.complete(b.id, { ok: false, error: "exited with code 1", output: "boom" }));
    assert.ok(q.complete(a.id, { ok: true, output: "done" }));
    assert.equal(q.complete(a.id, { ok: true, output: "again" }), false, "a result counts once");
    assert.deepEqual(await first, { ok: true, output: "done" });
    assert.deepEqual(await second, { ok: false, error: "exited with code 1", output: "boom" });
  });

  it("fails a job nobody takes, and one whose result never comes", async () => {
    const q = new HostDeployQueue({ pickupMs: 50, graceMs: 50 });
    assert.match((await q.run(job, "/x")).error!, /no host runner took the job/);
    const lost = q.run({ ...job, command: { command: "true", timeoutSec: 0 } }, "/x");
    assert.ok(q.next());
    assert.match((await lost).error!, /never reported a result/);
  });
});

describe("deploying from the Hub", () => {
  const call = (port: number, route: string, method = "GET") =>
    fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { authorization: `Bearer ${TOKEN}` } }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  it("deploys main after a task is merged, and on request", () =>
    withHub(async (ctx) => {
      const stateDir = path.join(ctx.repoDir, ".git", "aso");
      const out = tempDir("aso-deploy-out-");
      try {
        assert.equal((await call(ctx.port, "/api/projects/project/deploy", "POST")).status, 409, "no deploy.json yet");
        assert.equal((await call(ctx.port, "/api/projects/nope/deploy", "POST")).status, 404);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(path.join(stateDir, "deploy.json"), JSON.stringify({ project: { command: `cat greeting.txt >> "${path.join(out, "live")}" 2>/dev/null; echo "$ASO_DEPLOY_SHORT" >> "${path.join(out, "commits")}"` } }));

        const dev = await worker(ctx.port, "dev");
        const qa = await worker(ctx.port, "qa");
        await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "x" });
        assert.equal((await dev.next()).type, "TASK_ASSIGNMENT");
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet" }));
        const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greeting.txt": "hello\n" });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit }));
        const run = await qa.next();
        assert.equal(run.type, "TEST_EXECUTION");
        qa.send(createMessage("STATUS_UPDATE", "qa", { state: "in_progress", taskId: "greet" }));
        qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId: "greet", commit, outcome: "pass", summary: "ok" }));

        const project = await waitFor(async () => {
          const p = (await call(ctx.port, "/api/projects/project")).body;
          return p.deploy.last?.state === "succeeded" && p;
        }, 10_000, "deployed after the merge");
        const main = git(ctx.repoDir, "rev-parse", "main");
        assert.equal(project.deploy.last.commit, main);
        assert.equal(readFileSync(path.join(out, "live"), "utf8"), "hello\n", "the merged change is what got deployed");

        assert.deepEqual(await call(ctx.port, "/api/projects/project/deploy", "POST"), { status: 202, body: { deploying: true } });
        await waitFor(() => existsSync(path.join(out, "commits")) && readFileSync(path.join(out, "commits"), "utf8").split("\n").filter(Boolean).length === 2);
        dev.ws.close();
        qa.ws.close();
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }));

  it("hands deploys to the host when it runs in a container", () =>
    withHub(
      async (ctx) => {
        const stateDir = path.join(ctx.repoDir, ".git", "aso");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(path.join(stateDir, "deploy.json"), JSON.stringify({ project: { command: "ls", timeoutSec: 30 } }));
        assert.deepEqual((await call(ctx.port, "/api/deploys/next")).body, { job: null });
        assert.equal((await call(ctx.port, "/api/projects/project/deploy", "POST")).status, 202);
        const job = await waitFor(async () => (await call(ctx.port, "/api/deploys/next")).body.job, 5_000, "a job for the host");
        assert.deepEqual([job.project, job.commit, job.command], ["project", git(ctx.repoDir, "rev-parse", "main"), { command: "ls", timeoutSec: 30 }]);
        assert.ok(existsSync(path.join(stateDir, "deploy", "project", "README.md")), "the export is ready in the shared folder");

        const post = (body: unknown, id = job.id) =>
          fetch(`http://127.0.0.1:${ctx.port}/api/deploys/${id}/result`, {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        assert.equal((await post({ ok: true })).status, 400, "output is required");
        assert.equal((await post({ ok: true, output: "" }, "nope")).status, 404);
        assert.equal((await post({ ok: true, output: "README.md\n" })).status, 200);
        const last = await waitFor(async () => {
          const d = (await call(ctx.port, "/api/projects/project")).body.deploy.last;
          return d?.state === "succeeded" && d;
        });
        assert.equal(last.output, "README.md\n");
      },
      { deploy: { runner: "host" } },
    ));

  it("tells a host runner that a Hub outside a container runs deploys itself", () =>
    withHub(async (ctx) => {
      assert.equal((await call(ctx.port, "/api/deploys/next")).status, 404);
    }));
});
