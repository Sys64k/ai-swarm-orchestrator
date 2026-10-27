import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkToolUse, DEFAULT_JUNIOR_TRIES, DeskModels, desksOf, modelConcurrency, picked, type LlmAdapter } from "@aso/hub";
import { createMessage, type AgentMessage, type AvailableModel } from "@aso/shared";
import { postTask, pushTaskBranch, reply, ScriptedModel, tempDir, text, TOKEN, waitFor, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const fakeAdapter = (model: string): LlmAdapter => ({ name: "fake", model, complete: async () => reply([text("hi")], "end_turn") });
const isLocal = (spec: string) => /^(ollama\/|openai:)/.test(spec);
const open = (dir?: string) => DeskModels.open(dir, (spec) => fakeAdapter(spec), 4, isLocal);

describe("desk models", () => {
  it("saves which model each desk uses, owner-only and without secrets, and drops unused settings", async () => {
    const dir = tempDir();
    const desks = await open(dir);
    await desks.assign(["avalon#1", "avalon#2"], "openai:qwen3-coder:30b", { concurrency: 2 });
    await desks.assign(["canfod#1"], "claude-haiku-5-5");
    assert.equal(desks.modelOf("avalon#2"), "openai:qwen3-coder:30b");
    assert.equal(desks.route("openai:qwen3-coder:30b"), desks.route("openai:qwen3-coder:30b"), "one adapter and limit per model");

    const file = path.join(dir, "models.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(file, "utf8"), /key/i);
    const reopened = await open(dir);
    assert.deepEqual(reopened.view("opus", "haiku").desks, [
      { desk: "avalon#1", model: "openai:qwen3-coder:30b" },
      { desk: "avalon#2", model: "openai:qwen3-coder:30b" },
      { desk: "canfod#1", model: "claude-haiku-5-5" },
    ]);
    assert.equal(reopened.view(null, null).models.find((m) => m.model === "openai:qwen3-coder:30b")!.concurrency, 2, "settings survive a restart");

    await reopened.assign(["avalon#1", "avalon#2"], null);
    assert.equal(reopened.modelOf("avalon#1"), undefined, "back on the default");
    assert.doesNotMatch(readFileSync(file, "utf8"), /qwen/, "a model no desk uses is forgotten");
  });

  it("puts the Architect and the reviewer on models of their own, keeps them, and the reviewer follows the Architect by default", async () => {
    const dir = tempDir();
    const models = await open(dir);
    assert.deepEqual([models.view("opus", "haiku").architect, models.view("opus", "haiku").reviewer], ["opus", "opus"], "both on the Hub's --model");
    await models.assignRole("architect", "anthropic/claude-sonnet-5-5");
    assert.deepEqual([models.view("opus", null).architect, models.view("opus", null).reviewer], ["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"], "the reviewer follows the Architect");
    await models.assignRole("reviewer", "openai:qwen3-coder:30b", { concurrency: 2 });
    const reopened = await open(dir);
    assert.equal(reopened.roleModel("reviewer"), "openai:qwen3-coder:30b", "kept across restarts");
    assert.equal(reopened.view("opus", null).models.find((m) => m.model === "openai:qwen3-coder:30b")?.concurrency, 2, "its settings too, and its load shows");
    await assert.rejects(reopened.assignRole("architect", "machine/llama"), /a machine's own model serves only its own jobs/);
    await reopened.assignRole("reviewer", null);
    assert.equal(reopened.view("opus", null).reviewer, "anthropic/claude-sonnet-5-5", "back on the Architect's");
    assert.doesNotMatch(readFileSync(path.join(dir, "models.json"), "utf8"), /qwen/, "a model nothing uses is forgotten");
  });

  it("routes a role to its model, and to the Hub's --model when it has none or can't use it", async () => {
    let broken = false;
    const models = await DeskModels.open(undefined, (spec) => {
      if (broken) throw new Error("provider removed");
      return fakeAdapter(spec);
    }, 4, isLocal);
    assert.equal(models.roleRoute("architect"), undefined, "none: the Hub's --model");
    await models.assignRole("architect", "anthropic/claude-sonnet-5-5");
    assert.equal(models.roleRoute("reviewer")?.adapter.model, "anthropic/claude-sonnet-5-5", "the reviewer follows the Architect");
    broken = true;
    await assert.rejects(models.assignRole("reviewer", "openai/gpt-5"), /provider removed/, "a model it can't use is refused");
    assert.equal(models.roleModel("reviewer"), undefined, "and changes nothing");
    const fresh = await DeskModels.open(undefined, () => {
      throw new Error("provider removed");
    }, 4, isLocal);
    await assert.rejects(fresh.assignRole("architect", "x/y"));
    assert.equal(fresh.roleRoute("architect", true), undefined);
  });

  it("changes the escalation ladder and the junior tries over the Hub's start settings, and keeps them", async () => {
    const dir = tempDir();
    const start = { ladder: ["anthropic/claude-opus-5-5"], juniorTries: 2 };
    const models = await open(dir);
    assert.deepEqual(models.escalationPolicy(start), start, "nothing changed: the start settings");
    assert.deepEqual(models.view("opus", null, start).escalation, start);

    await models.setEscalation({ ladder: ["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"] });
    assert.deepEqual(models.escalationPolicy(start), { ladder: ["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"], juniorTries: 2 }, "the start's junior tries stay");
    await models.setEscalation({ juniorTries: 3 });
    const reopened = await open(dir);
    assert.deepEqual(reopened.escalationChoice(), { ladder: ["openai/gpt-6.1-sol", "anthropic/claude-opus-5-5"], juniorTries: 3 }, "kept across restarts");
    assert.ok(reopened.view("opus", null, start).models.some((m) => m.model === "openai/gpt-6.1-sol"), "a ladder model's load shows");

    await reopened.setEscalation({ ladder: null });
    assert.deepEqual(reopened.escalationPolicy(start), { ladder: ["anthropic/claude-opus-5-5"], juniorTries: 3 }, "the ladder back on the start's");
    await reopened.setEscalation({ juniorTries: null });
    assert.deepEqual(reopened.escalationChoice(), {}, "both back");
    assert.doesNotMatch(readFileSync(path.join(dir, "models.json"), "utf8"), /gpt-6/, "a model nothing uses is forgotten");
  });

  it("turns escalation on when the Hub started without it, and leaves it off otherwise", async () => {
    const models = await open();
    assert.equal(models.escalationPolicy(undefined), undefined);
    await models.setEscalation({ juniorTries: 1 });
    assert.equal(models.escalationPolicy(undefined), undefined, "tries alone don't make a ladder");
    assert.equal(models.view("opus", null).escalation, null, "off");
    await models.setEscalation({ ladder: ["openai/gpt-6.1-sol"] });
    assert.deepEqual(models.escalationPolicy(undefined), { ladder: ["openai/gpt-6.1-sol"], juniorTries: 1 });
    await models.setEscalation({ juniorTries: null });
    assert.deepEqual(models.escalationPolicy(undefined), { ladder: ["openai/gpt-6.1-sol"], juniorTries: DEFAULT_JUNIOR_TRIES });
  });

  it("refuses a ladder it can't use, and changes nothing then", async () => {
    let broken = false;
    const models = await DeskModels.open(undefined, (spec) => {
      if (broken && spec === "x/missing") throw new Error("no such provider");
      return fakeAdapter(spec);
    }, 4, isLocal);
    await models.setEscalation({ ladder: ["anthropic/claude-sonnet-5-5"], juniorTries: 2 });
    broken = true;
    await assert.rejects(models.setEscalation({ ladder: ["anthropic/claude-opus-5-5", "x/missing"], juniorTries: 4 }), /no such provider/);
    await assert.rejects(models.setEscalation({ ladder: ["machine/llama"] }), /machine\/llama can't take escalated tasks/);
    await assert.rejects(models.setEscalation({ ladder: ["a/b", "a/b"] }), /only once/);
    assert.deepEqual(models.escalationChoice(), { ladder: ["anthropic/claude-sonnet-5-5"], juniorTries: 2 }, "unchanged");
  });

  it("refuses a role or a ladder step on a model that can't take requests with tools, and changes nothing", async () => {
    const noTools = (spec: string): LlmAdapter => ({ name: "fake", model: spec, complete: async () => { throw new Error("bad request (400): Function tools are not supported"); } });
    const models = await DeskModels.open(undefined, (spec) => (spec === "openai/gpt-6.1-sol" ? noTools(spec) : fakeAdapter(spec)), 4, isLocal, checkToolUse);
    await assert.rejects(models.assignRole("reviewer", "openai/gpt-6.1-sol"), /gpt-6\.1-sol can't take the Hub's requests with tools: bad request \(400\)/);
    assert.equal(models.roleModel("reviewer"), undefined);
    await assert.rejects(models.setEscalation({ ladder: ["anthropic/claude-sonnet-5-5", "openai/gpt-6.1-sol"] }), /can't take the Hub's requests with tools/);
    assert.deepEqual(models.escalationChoice(), {});
    await models.assignRole("reviewer", "openai/gpt-6.1-terra");
    assert.equal(models.roleModel("reviewer"), "openai/gpt-6.1-terra", "a model that takes tools goes on");
  });

  it("keeps a trial across restarts, refuses one it can't run, and ends it", async () => {
    const dir = tempDir();
    const models = await open(dir);
    await models.setChallenger("reviewer", "openai/gpt-6.1-sol", { share: 0.2, budgetUsd: 3 }, new Date("2026-10-27T12:00:00.000Z"));
    assert.deepEqual((await open(dir)).challenger("reviewer"), { spec: "openai/gpt-6.1-sol", share: 0.2, budgetUsd: 3, since: "2026-10-27T12:00:00.000Z" });
    await assert.rejects(models.setChallenger("desks", "machine/llama", { share: 0.1, budgetUsd: 5 }), /machine's own model/);
    const noTools = await DeskModels.open(undefined, (spec) => ({ name: "f", model: spec, complete: async () => { throw new Error("no tools here"); } }), 4, isLocal, checkToolUse);
    await assert.rejects(noTools.setChallenger("desks", "x/y", { share: 0.1, budgetUsd: 5 }), /can't take the Hub's requests with tools/);
    assert.equal(noTools.challenger("desks"), undefined);
    await models.setChallenger("reviewer", null, { share: 0.1, budgetUsd: 5 });
    assert.equal((await open(dir)).challenger("reviewer"), undefined);
    assert.doesNotMatch(readFileSync(path.join(dir, "models.json"), "utf8"), /gpt-6/, "a model nothing uses is forgotten");
  });

  it("gives a local model one call at once unless told otherwise; Claude gets the Hub's limit", async () => {
    assert.equal(modelConcurrency({}, true, 4), 1, "a local server");
    assert.equal(modelConcurrency({ concurrency: 3 }, true, 4), 3);
    assert.equal(modelConcurrency({}, false, 4), 4, "a cloud API");
    const desks = await open();
    await desks.assign(["avalon#1"], "openai:m");
    const slots = desks.route("openai:m").slots;
    let release!: () => void;
    const first = slots.run(() => new Promise<void>((r) => (release = r)));
    const second = slots.run(async () => undefined);
    assert.deepEqual(slots.status(), { running: 1, waiting: 1, limit: 1 }, "the second call waits for the GPU");
    release();
    await Promise.all([first, second]);
  });

  it("refuses a model it can't use, and a failed save changes nothing", async () => {
    const strict = await DeskModels.open(undefined, (spec) => {
      if (spec.startsWith("claude")) throw new Error("no ANTHROPIC_API_KEY");
      return fakeAdapter(spec);
    }, 4, isLocal);
    await assert.rejects(strict.assign(["avalon#1"], "claude-opus-5-5"), /ANTHROPIC_API_KEY/);
    assert.equal(strict.modelOf("avalon#1"), undefined);

    const dir = tempDir();
    mkdirSync(path.join(dir, "models.json")); // a folder where the file goes: every save fails
    const broken = await open(dir);
    await assert.rejects(broken.assign(["avalon#1"], "openai:m"));
    assert.equal(broken.modelOf("avalon#1"), undefined);
  });

  it("starts with every desk on the default from a damaged file", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "models.json"), "{nope");
    assert.deepEqual((await open(dir)).view(null, null).desks, []);
  });

  it("turns a machine into its desks, and a desk into itself", () => {
    const workers = [{ hostname: "avalon", slots: 4 }, { hostname: "canfod", slots: 2 }];
    assert.deepEqual(desksOf("avalon#3", workers), ["avalon#3"]);
    assert.deepEqual(desksOf("canfod", workers), ["canfod#1", "canfod#2"]);
    const gone = desksOf("asusmini", workers);
    assert.ok(!Array.isArray(gone) && /asusmini isn't connected \(connected: avalon, canfod\); name a desk instead, e\.g\. asusmini#1/.test(gone.error));
  });
});

/** An OpenAI-compatible server: lists one model, and answers every call with "from the desk's model". */
async function fakeProvider() {
  let calls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.endsWith("/models")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "local-model" }] }));
      calls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ model: "local-model", choices: [{ delta: { content: "from the desk's model" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls: () => calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const call = (port: number, route: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

function promptResult(m: AgentMessage) {
  assert.equal(m.type, "PROMPT_RESULT");
  return m.type === "PROMPT_RESULT" ? m.payload : assert.fail();
}

describe("desks on their own models (Hub)", () => {
  it("runs the acceptance check on the reviewer's model, and plans on the Architect's, as chosen while the Hub runs", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    const hubModel = new ScriptedModel(() => reply([text("from --model")], "end_turn"), "claude-opus-5-5");
    try {
      await withHub(
        async (ctx) => {
          const set = await call(ctx.port, "/api/models/roles", { role: "reviewer", model: "local-model" });
          assert.equal(set.status, 200, JSON.stringify(set.body));
          assert.deepEqual([set.body.architect, set.body.reviewer], ["claude-opus-5-5", "local/local-model"]);
          assert.equal((await call(ctx.port, "/api/models")).body.reviewer, "local/local-model");
          assert.equal((await call(ctx.port, "/api/models/roles", { role: "architect", model: "machine/llama" })).status, 400);
          assert.equal((await call(ctx.port, "/api/models/roles", { role: "boss", model: "local-model" })).status, 400);

          const dev = await worker(ctx.port, "dev");
          const qa = await worker(ctx.port, "qa");
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d", acceptanceCriteria: ["it greets"] });
          assert.equal((await dev.next()).type, "TASK_ASSIGNMENT");
          dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
          const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greet.txt": "hi\n" });
          dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit }));
          assert.equal((await qa.next()).type, "TEST_EXECUTION");
          qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId: "greet", commit, outcome: "pass", summary: "ok" }));
          await waitFor(() => ctx.hub.tasks.get("greet")?.jobs?.[0]?.acceptance !== undefined, 10_000, "the acceptance check");
          assert.equal(ctx.hub.tasks.get("greet")!.jobs![0].acceptanceModel, "local-model", "checked on the reviewer's model");
          assert.equal(provider.calls(), 2, "one call to check it takes tools, one for the check");
          assert.equal(hubModel.requests.length, 0, "not on --model");

          await call(ctx.port, "/api/models/roles", { role: "architect", model: "local-model" });
          assert.equal((await call(ctx.port, "/api/llm")).body.model, "local-model", "the Architect plans there now");
          dev.ws.close();
          qa.ws.close();
        },
        { llm: { adapter: hubModel } },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });

  it("tries a challenger on a share of the tasks (desks) and of the checks (reviewer), and ends the trial", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    const defaultModel = new ScriptedModel(() => reply([text("from the default")], "end_turn"), "claude-haiku-5-5");
    // Task ids each trial takes at 50%: the share is a hash of the id, so find some.
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const desksTakes = ids.find((id) => picked(`desks:${id}`, 0.5) && !picked(`reviewer:${id}`, 0.5))!;
    const reviewerTakes = ids.find((id) => picked(`reviewer:${id}`, 0.5) && !picked(`desks:${id}`, 0.5))!;
    try {
      await withHub(
        async (ctx) => {
          assert.equal((await call(ctx.port, "/api/models/challengers", { role: "desks", model: "machine/llama" })).status, 400);
          assert.equal((await call(ctx.port, "/api/models/challengers", { role: "desks", model: "local-model", share: 0.9 })).status, 400, "at most half the work");
          const set = await call(ctx.port, "/api/models/challengers", { role: "desks", model: "local-model", share: 0.5, budgetUsd: 2 });
          assert.equal(set.status, 200, JSON.stringify(set.body));
          assert.deepEqual((({ since, ...t }) => t)(set.body.challengers.desks), { model: "local/local-model", share: 0.5, budgetUsd: 2, samples: 0, needed: 10, spentUsd: 0 });
          await call(ctx.port, "/api/models/challengers", { role: "reviewer", model: "local-model", share: 0.5 });

          const dev = await worker(ctx.port, "dev");
          const qa = await worker(ctx.port, "qa");
          // A task the desks trial takes starts on the challenger.
          await postTask(ctx.port, { taskId: desksTakes, role: "backend", title: "On trial", description: "d" });
          assert.equal((await dev.next()).type, "TASK_ASSIGNMENT");
          dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: desksTakes, slot: 1 }));
          await waitFor(() => ctx.hub.tasks.get(desksTakes)?.state === "in_progress");
          dev.send(createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId: desksTakes, conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
          assert.match(JSON.stringify(promptResult(await dev.next(5000))), /from the desk's model/);
          const onTrial = ctx.hub.tasks.get(desksTakes)!;
          assert.equal(onTrial.challenger, "local/local-model");
          assert.ok(onTrial.history.some((h) => /\(local-model, a model on trial\)/.test(h.event)));
          await call(ctx.port, `/api/tasks/${desksTakes}/cancel`, {});
          await waitFor(() => ctx.hub.tasks.get(desksTakes)?.state === "cancelled");

          // A task the reviewer trial takes: its acceptance check runs on the challenger.
          await postTask(ctx.port, { taskId: reviewerTakes, role: "backend", title: "Checked on trial", description: "d", acceptanceCriteria: ["it greets"] });
          // Whichever machine is free builds it; the other tests it.
          const builderId = await waitFor(() => ctx.hub.tasks.get(reviewerTakes)?.nodeId, 5000, "assigned");
          const [builder, tester] = builderId === "dev" ? [dev, qa] : [qa, dev];
          let next = await builder.next();
          while (next.type !== "TASK_ASSIGNMENT") next = await builder.next(); // the cancel's stop message first
          builder.send(createMessage("STATUS_UPDATE", builderId, { state: "in_progress", taskId: reviewerTakes, slot: 1 }));
          const commit = await pushTaskBranch(ctx.gitUrl, reviewerTakes, { "greet.txt": "hi\n" });
          builder.send(createMessage("STATUS_UPDATE", builderId, { state: "completed", taskId: reviewerTakes, commit }));
          let run = await tester.next();
          while (run.type !== "TEST_EXECUTION") run = await tester.next();
          tester.send(createMessage("FEEDBACK_LOOP", builderId === "dev" ? "qa" : "dev", { taskId: reviewerTakes, commit, outcome: "pass", summary: "ok" }));
          await waitFor(() => ctx.hub.tasks.get(reviewerTakes)?.jobs?.[0]?.acceptance !== undefined, 10_000, "the acceptance check");
          assert.equal(ctx.hub.tasks.get(reviewerTakes)!.jobs![0].acceptanceModel, "local-model", "checked by the challenger");
          assert.equal(ctx.hub.tasks.get(reviewerTakes)!.challenger, undefined, "not on the desks trial");

          const ended = await call(ctx.port, "/api/models/challengers", { role: "desks", model: "none" });
          assert.equal(ended.body.challengers.desks, undefined);
          assert.ok(ended.body.challengers.reviewer, "the other trial goes on");
          dev.ws.close();
          qa.ws.close();
        },
        { llm: { adapter: new ScriptedModel(() => reply([text("from --model")], "end_turn"), "claude-opus-5-5"), agentAdapter: defaultModel } },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });

  it("lists the local models, puts a desk on one by name, and runs its agent there", async () => {
    const provider = await fakeProvider();
    const saved = process.env.ASO_LLM_BASE_URL;
    process.env.ASO_LLM_BASE_URL = provider.url;
    const defaultModel = new ScriptedModel(() => reply([text("from the default")], "end_turn"), "claude-haiku-5-5");
    try {
      await withHub(
        async (ctx) => {
          const models = (await call(ctx.port, "/api/models")).body;
          assert.deepEqual(models.available.map((m: AvailableModel) => m.model), ["local-model"]);

          // The worker's hostname is "test", with desks test#1...
          const w = await worker(ctx.port, "dev");
          const set = await call(ctx.port, "/api/desks", { target: "test#1", model: "local-model" });
          assert.equal(set.status, 200, JSON.stringify(set.body));
          assert.deepEqual(set.body.desks, [{ desk: "test#1", model: "local/local-model" }]);
          assert.equal(set.body.models[0].concurrency, 1, "a local model gets one call at once");
          const typo = await call(ctx.port, "/api/desks", { target: "test#1", model: "local" });
          assert.equal(typo.status, 400);
          assert.match(typo.body.error, /Did you mean "local-model"/);
          assert.equal((await call(ctx.port, "/api/desks", { target: "elsewhere", model: "local-model" })).status, 404);

          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
          assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
          w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
          await waitFor(() => ctx.hub.tasks.get("greet")?.state === "in_progress");
          w.send(createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId: "greet", conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
          const r = promptResult(await w.next(5000));
          assert.equal(r.outcome, "ok");
          assert.match(JSON.stringify(r), /from the desk's model/);
          assert.equal(provider.calls(), 1);
          assert.equal(defaultModel.requests.length, 0, "the default agent model wasn't used");
          assert.ok(ctx.hub.tasks.get("greet")!.history.some((h) => /\(local-model, this desk's model\)/.test(h.event)), "the task says which model worked on it");

          const whole = await call(ctx.port, "/api/desks", { target: "test", model: "default" });
          assert.deepEqual(whole.body.desks, [], "the whole machine back on the default");
          w.ws.close();
        },
        { llm: { adapter: new ScriptedModel(() => assert.fail("a task agent reached the Architect's model")), agentAdapter: defaultModel } },
      );
    } finally {
      if (saved === undefined) delete process.env.ASO_LLM_BASE_URL;
      else process.env.ASO_LLM_BASE_URL = saved;
      await provider.close();
    }
  });
});
