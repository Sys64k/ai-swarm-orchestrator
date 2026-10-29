import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDispute, lockedTests, mayDispute, roleOf, testsFirstNote, writingTests } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import { git, gitAsync, postTask, pushTaskBranch, reply, ScriptedModel, tempDir, text, TOKEN, waitFor, withHub, worker, writeFiles, type HubContext, type TestClient } from "./helpers.ts";

function expectType<T extends AgentMessage["type"]>(m: AgentMessage, type: T): Extract<AgentMessage, { type: T }> {
  assert.equal(m.type, type);
  return m as Extract<AgentMessage, { type: T }>;
}

/** A commit on top of the task's branch, as an agent's next round pushes it; `remove` deletes files. */
async function pushOnTop(gitUrl: string, taskId: string, files: Record<string, string>, remove: string[] = []): Promise<string> {
  const dir = tempDir("aso-tests-first-");
  await gitAsync(dir, "clone", "--quiet", gitUrl, ".");
  git(dir, "checkout", "--quiet", "-b", `task/${taskId}`, `origin/task/${taskId}`);
  writeFiles(dir, files);
  for (const f of remove) git(dir, "rm", "--quiet", f);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", `round on ${taskId}`);
  await gitAsync(dir, "push", "--quiet", "origin", `task/${taskId}`);
  return git(dir, "rev-parse", "HEAD");
}

/** Start the assigned agent's conversation and return what its model was asked first. */
async function firstTurn(w: TestClient, taskId: string) {
  w.send(createMessage("PROMPT_EXECUTION", "dev", { requestId: crypto.randomUUID(), taskId, conversationId: crypto.randomUUID(), turn: 0, toolResults: [] } as never));
  expectType(await w.next(5000), "PROMPT_RESULT");
}

const TEST = "greet.test.mjs";
const WRITTEN = 'import assert from "node:assert";\nassert.equal((await import("./greet.mjs")).greet(), "hello");\n';

describe("tests-first tasks", () => {
  it("knows the agent's role and phase from the task", () => {
    const spec = { role: "backend" as const };
    assert.equal(roleOf({ spec, testsFirst: { phase: "tests", files: [] } }), "qa", "the test writer edits test files only");
    assert.equal(roleOf({ spec, testsFirst: { phase: "build", files: [TEST] } }), "backend");
    assert.equal(roleOf({ spec }), "backend");
    assert.deepEqual([writingTests({ testsFirst: { phase: "tests", files: [] } }), writingTests({})], [true, false]);
    assert.deepEqual(lockedTests({ testsFirst: { phase: "build", commit: "c", files: [TEST] } }), { since: "c", files: [TEST] });
    assert.equal(lockedTests({ testsFirst: { phase: "tests", commit: "c", files: [TEST] } }), undefined, "nothing is locked while they're written");
    assert.equal(lockedTests({ testsFirst: { phase: "build", commit: "c", files: [] } }), undefined);
    const building = { testsFirst: { phase: "build" as const, files: [TEST] } };
    assert.deepEqual([canDispute(building, true), canDispute(building, false), canDispute({ testsFirst: { ...building.testsFirst, disputed: true } }, true), canDispute({}, true)], [true, false, false, false], "a dispute sends the tests back once");
    assert.deepEqual([mayDispute(building), mayDispute({ testsFirst: { ...building.testsFirst, disputed: true } }), mayDispute({ testsFirst: { phase: "tests", files: [] } })], [true, false, false]);
    assert.deepEqual(testsFirstNote({ testsFirst: { phase: "tests", files: [] } }), [], "nothing to say until they're written");
    assert.deepEqual(testsFirstNote({ jobs: [{ job: "implement", round: 0, host: "h", slot: 1, nodeId: "n", model: "claude-opus-5-5", writesTests: true, startedAt: "t", calls: 1, costUsd: 0 }], testsFirst: { phase: "build", files: [TEST], disputed: true } }), [
      "**Tests written first** by `claude-opus-5-5`: `greet.test.mjs` (back to their writer once after the builder disputed them); the builder couldn't change them",
    ]);
  });

  it("has the Architect's model write the tests as QA, then a builder make them pass without changing them", async () => {
    const architect = new ScriptedModel(() => reply([text("writing tests")], "end_turn"), "claude-opus-5-5");
    const builder = new ScriptedModel(() => reply([text("building")], "end_turn"), "claude-haiku-5-5");
    await withHub(
      async (ctx: HubContext) => {
        const dev = await worker(ctx.port, "dev", { hostname: "avalon" });
        await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "Add greet().", acceptanceCriteria: ["greet() says hello"], testsFirst: true });

        // 1. The test writer: QA's role, the Architect's model, its own brief.
        const writing = expectType(await dev.next(), "TASK_ASSIGNMENT").payload;
        assert.equal(writing.role, "qa");
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        await firstTurn(dev, "greet");
        assert.equal(builder.requests.length, 0);
        assert.match(architect.requests[0].system, /You are the QA engineer/);
        assert.match(architect.requests[0].messages[0].content as string, /^# Tests first for task greet: Greet[\s\S]*## Your job: write the tests that define done/);
        const tests = await pushTaskBranch(ctx.gitUrl, "greet", { [TEST]: WRITTEN });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: tests, detail: "greet.test.mjs: greet() returns hello" }));

        // 2. No QA on failing tests: straight to a builder, told what the tests are.
        const building = expectType(await dev.next(5000), "TASK_ASSIGNMENT").payload;
        assert.equal(building.role, "backend");
        const task = ctx.hub.tasks.get("greet")!;
        assert.deepEqual(task.testsFirst, { phase: "build", commit: tests, files: [TEST], notes: "greet.test.mjs: greet() returns hello" });
        assert.ok(task.history.some((h) => /tests written first \(greet\.test\.mjs\)/.test(h.event)));
        assert.equal(task.reworkRound, 0, "writing the tests isn't a rework round");
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        await firstTurn(dev, "greet");
        assert.match(builder.requests[0].messages[0].content as string, /## Tests written first\n.*can't change them[\s\S]*- greet\.test\.mjs\n\nThe test writer's notes:\ngreet\.test\.mjs: greet\(\) returns hello/);
        assert.match(task.history.map((h) => h.event).join("\n"), /\(claude-opus-5-5, writes the tests first\)[\s\S]*\(claude-haiku-5-5/);

        // 3. A builder that loosens the test is refused.
        const loosened = await pushOnTop(ctx.gitUrl, "greet", { [TEST]: "// nothing to check\n", "greet.mjs": "export const greet = () => 'hi';\n" });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: loosened }));
        const back = expectType(await dev.next(5000), "TASK_ASSIGNMENT").payload;
        assert.match(back.rework!.reason, /changes the tests written first \(greet\.test\.mjs\)/);

        // Deleting it is changing it too.
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        const deleted = await pushOnTop(ctx.gitUrl, "greet", {}, [TEST]);
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: deleted }));
        assert.match(expectType(await dev.next(5000), "TASK_ASSIGNMENT").payload.rework!.reason, /changes the tests written first \(greet\.test\.mjs\)/);

        // 4. Putting the test back and writing the code goes through QA to main.
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        const fixed = await pushOnTop(ctx.gitUrl, "greet", { [TEST]: WRITTEN, "greet.mjs": "export const greet = () => 'hello';\n" });
        // QA joins only now, so the builds above can't go to its machine.
        const qa = await worker(ctx.port, "qa", { hostname: "canfod" });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: fixed }));
        const run = expectType(await qa.next(5000), "TEST_EXECUTION").payload;
        assert.equal(run.commit, fixed);
        qa.send(createMessage("STATUS_UPDATE", "qa", { state: "in_progress", taskId: "greet", slot: 1 }));
        qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId: "greet", commit: fixed, outcome: "pass", summary: "ok" }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged");
        assert.deepEqual(
          task.jobs!.filter((j) => j.job === "implement").map((j) => [j.model, j.writesTests ?? false]),
          [["claude-opus-5-5", true], ["claude-haiku-5-5", false], [undefined, false], [undefined, false]],
          "the test writer's job, then three builds (the last two made no model call here)",
        );
        const byModel = await fetch(`http://127.0.0.1:${ctx.port}/api/track-records?by=model`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json());
        assert.ok(!byModel.rows.some((r: { key: string; builds: { jobs: number } }) => r.key === "claude-opus-5-5" && r.builds.jobs), "the test writer's job isn't a build");
        dev.ws.close();
        qa.ws.close();
      },
      { llm: { adapter: architect, agentAdapter: builder, agentModel: "claude-haiku-5-5", escalation: false }, acceptanceCheck: false },
    );
  });

  it("sends the tests back to their writer once when the builder disputes them; a plain give-up is a rework round", async () => {
    await withHub(
      async (ctx: HubContext) => {
        const dev = await worker(ctx.port, "dev", { hostname: "avalon" });
        await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d", testsFirst: true });
        expectType(await dev.next(), "TASK_ASSIGNMENT");
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        const tests = await pushTaskBranch(ctx.gitUrl, "greet", { [TEST]: WRITTEN });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: tests }));

        expectType(await dev.next(5000), "TASK_ASSIGNMENT");
        // A give-up that doesn't dispute the tests: an ordinary rework round, still the builder's.
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "greet", detail: "couldn't finish in time", gaveUp: true }));
        assert.equal(expectType(await dev.next(5000), "TASK_ASSIGNMENT").payload.role, "backend");
        assert.equal(ctx.hub.tasks.get("greet")!.reworkRound, 1);
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        // The builder's unfinished code is saved on the branch as it disputes a test.
        const saved = await pushOnTop(ctx.gitUrl, "greet", { "greet.mjs": "export const greet = () => {};\n" });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "greet", detail: "the builder disputes a test written first: greet.test.mjs: it imports greet.js, the task says greet.mjs", disputesTests: true }));

        const rewriting = expectType(await dev.next(5000), "TASK_ASSIGNMENT").payload;
        assert.equal(rewriting.role, "qa", "back to the test writer");
        assert.match(rewriting.rework!.reason, /^The builder disputes the tests you wrote first: .*greet\.mjs\. If it's right, fix the tests/);
        const task = ctx.hub.tasks.get("greet")!;
        assert.deepEqual([task.testsFirst!.phase, task.testsFirst!.disputed, task.testsFirst!.from, task.reworkRound], ["tests", true, saved, 1], "a dispute isn't a rework round");

        // The writer adds a test on top of the builder's code: only its own change is checked
        // against QA's scope (greet.mjs isn't its), and only its tests are locked.
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        const revised = await pushOnTop(ctx.gitUrl, "greet", { "edge.test.mjs": "// edge cases\n" });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit: revised }));
        expectType(await dev.next(5000), "TASK_ASSIGNMENT");
        assert.deepEqual(task.testsFirst, { phase: "build", commit: revised, files: ["edge.test.mjs", TEST], disputed: true });

        // A second dispute is an ordinary give-up: a rework round for the builder.
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "failed", taskId: "greet", detail: "still wrong", disputesTests: true }));
        const again = expectType(await dev.next(5000), "TASK_ASSIGNMENT").payload;
        assert.equal(again.role, "backend");
        assert.equal(task.reworkRound, 2);
        assert.match(again.rework!.reason, /^The previous agent gave up: still wrong/);
        dev.ws.close();
      },
      { acceptanceCheck: false },
    );
  });
});
