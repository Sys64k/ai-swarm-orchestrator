import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { startHub, StateStore, type HubHandle, type HubOptions } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import {
  getTask,
  makeTargetRepo,
  postTask,
  pushTaskBranch,
  reply,
  ScriptedModel,
  tempDir,
  text,
  TOKEN,
  toolUse,
  waitFor,
  worker,
} from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

/** A target repo whose Hub can be stopped and started again, like a redeploy. */
async function restartable(opts: Partial<HubOptions> = {}) {
  const repoDir = makeTargetRepo();
  let hub: HubHandle | undefined;
  const start = async () => {
    hub = await startHub({ targetDir: repoDir, port: 0, host: "127.0.0.1", token: TOKEN, ...opts });
    return hub;
  };
  return {
    repoDir,
    stateDir: path.join(repoDir, ".git", "aso"),
    start,
    restart: async () => {
      await hub!.close();
      return start();
    },
    cleanup: async () => {
      await hub?.close();
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

function result(m: AgentMessage) {
  assert.equal(m.type, "PROMPT_RESULT");
  return m.type === "PROMPT_RESULT" ? m.payload : assert.fail();
}

const api = (port: number, route: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.json() as Promise<Record<string, any>>);

describe("state store", () => {
  it("starts empty without a state file and round-trips a snapshot", async () => {
    const dir = tempDir();
    try {
      const store = new StateStore(dir);
      assert.equal(await store.load(), undefined);
      store.scheduleSave(() => ({ tasks: [{ id: 1 }], plans: [{ id: 2 }] }));
      await store.flush();
      assert.deepEqual(await new StateStore(dir).load(), { tasks: [{ id: 1 }], plans: [{ id: 2 }] });
      assert.deepEqual(readdirSync(dir), ["state.json"], "no temp files left behind");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets an unreadable or incompatible state file aside instead of deleting it", async () => {
    const dir = tempDir();
    try {
      for (const content of ["{not json", JSON.stringify({ version: 99, tasks: [], plans: [] }), JSON.stringify({ version: 1, tasks: {} })]) {
        writeFileSync(path.join(dir, "state.json"), content);
        assert.equal(await new StateStore(dir).load(), undefined);
        assert.ok(!existsSync(path.join(dir, "state.json")));
        const aside = readdirSync(dir).filter((f) => f.startsWith("state.json.unreadable-"));
        assert.ok(aside.some((f) => readFileSync(path.join(dir, f), "utf8") === content), "original content kept");
        for (const f of aside) rmSync(path.join(dir, f));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves conversations under safe names only and stops writing once closed", async () => {
    const dir = tempDir();
    try {
      const store = new StateStore(dir);
      store.saveConversation("../escape", { a: 1 });
      store.saveConversation("c-1", { a: 1 });
      store.saveConversation("c-2", { a: 2 });
      store.deleteConversation("c-2");
      await store.flush();
      assert.deepEqual(await store.loadConversations(), [{ a: 1 }]);
      assert.ok(!existsSync(path.join(dir, "..", "escape.json")));

      await store.close();
      store.saveConversation("c-3", { a: 3 });
      store.scheduleSave(() => ({ tasks: [], plans: [] }));
      await store.flush();
      assert.deepEqual(readdirSync(path.join(dir, "conversations")), ["c-1.json"]);
      assert.ok(!existsSync(path.join(dir, "state.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Hub restart", () => {
  it("keeps tasks and plans, and dispatches restored work to workers that connect later", async () => {
    const env = await restartable();
    try {
      let hub = await env.start();
      await postTask(hub.port, { taskId: "api", role: "backend", title: "API", description: "Build it" });
      await postTask(hub.port, { taskId: "ui", role: "frontend", title: "UI", description: "Build it", dependsOn: ["api"] });
      const plan = await api(hub.port, "/api/plans", { method: "POST", body: JSON.stringify({ requirement: "a todo app" }) });

      hub = await env.restart();
      const health = await api(hub.port, "/api/health");
      assert.equal(health.stateDir, env.stateDir);
      const tasks = (await api(hub.port, "/api/tasks")) as unknown as Array<Record<string, any>>;
      assert.deepEqual(tasks.map((t) => [t.spec.taskId, t.state]), [["api", "pending"], ["ui", "pending"]]);
      assert.equal((await api(hub.port, `/api/plans/${plan.planId}`)).requirement, "a todo app");
      await assert.rejects(() => postTask(hub.port, { taskId: "api", role: "backend", title: "x", description: "x" }).then((r) => {
        if (r.status === 409) throw new Error("duplicate");
      }), /duplicate/, "restored ids stay taken");

      const w = await worker(hub.port, "dev");
      const assignment = await w.next();
      assert.ok(assignment.type === "TASK_ASSIGNMENT" && assignment.payload.taskId === "api");
      w.ws.close();
    } finally {
      await env.cleanup();
    }
  });

  it("requeues a job the worker had not started yet, without counting it as a node drop", async () => {
    const env = await restartable();
    try {
      let hub = await env.start();
      const w = await worker(hub.port, "dev");
      await postTask(hub.port, { taskId: "api", role: "backend", title: "API", description: "Build it" });
      assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
      await waitFor(() => hub.tasks.get("api")?.state === "assigned");

      hub = await env.restart();
      const task = hub.tasks.get("api")!;
      assert.equal(task.state, "pending");
      assert.equal(task.nodeId, undefined);
      assert.equal(task.drops, 0);
      assert.match(task.history.at(-1)!.event, /Hub restarted before work started/);
    } finally {
      await env.cleanup();
    }
  });

  it("lets an agent carry on mid-task: the worker reclaims the job and the conversation continues", async () => {
    const model = new ScriptedModel((_req, n) =>
      n === 0 ? reply([text("Looking."), toolUse("tu_1", "list_files", {})]) : reply([text("Done.")], "end_turn"),
    );
    const env = await restartable({ llm: { adapter: model } });
    try {
      let hub = await env.start();
      let w = await worker(hub.port, "dev");
      await postTask(hub.port, { taskId: "greet", role: "backend", title: "Greet", description: "Say hello" });
      assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
      w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet" }));
      await waitFor(() => hub.tasks.get("greet")?.state === "in_progress");

      const conversationId = crypto.randomUUID();
      const turn0 = createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId: "greet", conversationId, turn: 0, toolResults: [] });
      w.send(turn0);
      const r0 = result(await w.next());
      assert.equal(r0.outcome, "ok");

      hub = await env.restart();
      const held = hub.tasks.get("greet")!;
      assert.equal(held.state, "in_progress");
      assert.equal(held.nodeId, "dev");
      assert.ok(held.detachedAt !== undefined, "held for the worker to reconnect");
      assert.equal(held.llm.calls, 1, "cost so far survives");

      w = await worker(hub.port, "dev", { resume: { taskId: "greet", job: "implement" } });
      await waitFor(() => hub.tasks.get("greet")?.detachedAt === undefined, 2000, "resume");

      // A turn whose answer was lost in the restart is answered again without a new model call.
      w.send({ ...turn0, id: crypto.randomUUID() });
      assert.deepEqual(result(await w.next()), r0);
      assert.equal(model.requests.length, 1);

      w.send(createMessage("PROMPT_EXECUTION", "dev", {
        requestId: crypto.randomUUID(),
        taskId: "greet",
        conversationId,
        turn: 1,
        toolResults: [{ toolUseId: "tu_1", content: "README.md" }],
      }));
      const r1 = result(await w.next());
      assert.ok(r1.outcome === "ok" && r1.text === "Done.");
      assert.equal(model.requests[1].messages.length, 3, "the model sees the history from before the restart");
      assert.match(model.requests[1].system, /backend engineer/);
      w.ws.close();
    } finally {
      await env.cleanup();
    }
  });

  it("runs Hub-side steps again: a task caught mid-verification is verified after the restart", async () => {
    const env = await restartable();
    try {
      const hub = await env.start();
      await postTask(hub.port, { taskId: "api", role: "backend", title: "API", description: "Build it" });
      const commit = await pushTaskBranch(`http://127.0.0.1:${hub.port}/git/project.git`, "api", { "api.ts": "export {};\n" });
      await hub.close();

      // As if the Hub stopped right after the worker reported its push.
      const file = path.join(env.stateDir, "state.json");
      const state = JSON.parse(readFileSync(file, "utf8"));
      Object.assign(state.tasks[0], { state: "verifying", commit, nodeId: "dev" });
      writeFileSync(file, JSON.stringify(state));

      const restarted = await env.start();
      await waitFor(() => restarted.tasks.get("api")?.state === "awaiting_qa", 5000, "verification");
      assert.equal((await getTask(restarted.port, "api")).commit, commit);
    } finally {
      await env.cleanup();
    }
  });

  it("keeps state in memory only when stateDir is null", async () => {
    const env = await restartable({ stateDir: null });
    try {
      let hub = await env.start();
      await postTask(hub.port, { taskId: "api", role: "backend", title: "API", description: "Build it" });
      hub = await env.restart();
      assert.equal(hub.tasks.list().length, 0);
      assert.ok(!existsSync(env.stateDir));
      assert.equal((await api(hub.port, "/api/health")).stateDir, null);
    } finally {
      await env.cleanup();
    }
  });
});
