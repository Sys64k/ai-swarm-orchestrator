import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AcceptanceChecker,
  acceptanceNote,
  acceptancePrompt,
  diffText,
  readVerdict,
  unmetReason,
  type AcceptanceVerdict,
  type LlmAdapter,
  type LlmRequest,
} from "@aso/hub";
import { createMessage, type AgentMessage, type TaskDiff } from "@aso/shared";
import { git, gitAsync, postTask, pushTaskBranch, reply, tempDir, text, toolUse, waitFor, withHub, worker, writeFiles, type HubContext, type TestClient } from "./helpers.ts";

const TASK = {
  spec: { title: "Mock Hub: /api/llm", description: "Serve GET /api/llm from the mock Hub.", acceptanceCriteria: ["GET /api/llm answers the status", "The llm-none scenario answers 404"] },
  summary: "Added the endpoint.",
};
const DIFF: TaskDiff = {
  base: "a",
  head: "b",
  truncated: false,
  files: [{ path: "tests/e2e/mock-hub.ts", status: "modified", additions: 3, deletions: 0, binary: false, patch: "+if (parts[0] === \"llm\") return sendJson(res, 200, status);" }],
};

/** A model that answers every request with `answer`, and remembers the requests. */
function model(answer: () => ReturnType<typeof reply>, name = "claude-opus-5-5"): LlmAdapter & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return { name: "scripted", model: name, requests, complete: async (r) => (requests.push(r), answer()) };
}
const verdictCall = (criteria: Array<{ index: number; verdict: string; reason: string }>, summary = "ok") =>
  reply([toolUse("v1", "report_acceptance", { criteria, summary })], "tool_use");

describe("acceptance check", () => {
  it("asks for each criterion against the diff, and trusts the agent's summary only as a claim", () => {
    const prompt = acceptancePrompt(TASK, DIFF);
    assert.match(prompt, /1\. GET \/api\/llm answers the status\n2\. The llm-none scenario answers 404/);
    assert.match(prompt, /The agent's own summary \(a claim, not proof\):\nAdded the endpoint\./);
    assert.match(prompt, /--- tests\/e2e\/mock-hub\.ts \(modified, \+3\/-0\)/);
    assert.doesNotMatch(prompt, /cut/);
  });

  it("cuts a large diff and says so", () => {
    const big = { ...DIFF, files: [DIFF.files[0], { ...DIFF.files[0], path: "big.ts", patch: "x".repeat(200) }] };
    const { text, cut } = diffText(big, 120);
    assert.ok(cut);
    assert.match(text, /big\.ts \(modified, \+3\/-0\): left out, the diff is too large/);
    assert.match(acceptancePrompt(TASK, { ...DIFF, truncated: true }), /The diff \(cut: parts are left out, so mark what you can't see as unclear\)/);
  });

  it("reads a verdict per criterion, and refuses an answer that skips one", () => {
    const ok = readVerdict(verdictCall([{ index: 1, verdict: "met", reason: "routed" }, { index: 2, verdict: "unmet", reason: "no scenario" }]).content, TASK.spec.acceptanceCriteria);
    assert.ok(!("error" in ok));
    assert.deepEqual(ok.criteria.map((c) => c.verdict), ["met", "unmet"]);
    const skipped = readVerdict(verdictCall([{ index: 1, verdict: "met", reason: "x" }]).content, TASK.spec.acceptanceCriteria);
    assert.ok("error" in skipped && /skips criterion 2/.test(skipped.error));
    assert.ok("error" in readVerdict(reply([{ type: "text", text: "Looks good" }], "end_turn").content, TASK.spec.acceptanceCriteria));
  });

  it("decides met, unmet or undecided, and never blocks on its own failure", async () => {
    const met = await new AcceptanceChecker(async () => [model(() => verdictCall([{ index: 1, verdict: "met", reason: "a" }, { index: 2, verdict: "unclear", reason: "outside the diff" }]))]).check(TASK, DIFF);
    assert.equal(met.result, "met", "unclear doesn't block");
    const scripted = model(() => verdictCall([{ index: 1, verdict: "met", reason: "a" }, { index: 2, verdict: "unmet", reason: "no llm-none scenario" }]));
    const unmet = await new AcceptanceChecker(async () => [scripted]).check(TASK, DIFF);
    assert.equal(unmet.result, "unmet");
    assert.equal(scripted.requests[0].tools[0].name, "report_acceptance");
    assert.ok(unmet.result !== "undecided" && unmet.usage.inputTokens > 0, "its cost is counted");

    const failing: LlmAdapter = { name: "x", model: "m", complete: async () => { throw new Error("overloaded"); } };
    assert.deepEqual(await new AcceptanceChecker(async () => [failing]).check(TASK, DIFF), { result: "undecided", reason: "the model failed: overloaded", model: "m" });
    assert.equal((await new AcceptanceChecker(async () => [undefined]).check(TASK, DIFF)).result, "undecided");
    assert.equal((await new AcceptanceChecker(async () => [scripted]).check(TASK, { ...DIFF, files: [] })).result, "undecided");
  });

  it("hands the check to the next model when the reviewer's call fails, not when its answer is unreadable", async () => {
    const refused: LlmAdapter = { name: "x", model: "gpt-6.1-sol", complete: async () => { throw new Error("bad request (400): Function tools with reasoning_effort are not supported"); } };
    const opus = model(() => verdictCall([{ index: 1, verdict: "met", reason: "a" }, { index: 2, verdict: "met", reason: "b" }]));
    const fell = await new AcceptanceChecker(async () => [refused, undefined, opus]).check(TASK, DIFF);
    assert.equal(fell.result, "met");
    assert.equal(fell.model, opus.model, "the verdict counts for the model that gave it");

    const down: LlmAdapter = { ...refused, model: "other", complete: async () => { throw new Error("overloaded"); } };
    const both = await new AcceptanceChecker(async () => [refused, down]).check(TASK, DIFF);
    assert.equal(both.result, "undecided");
    assert.match(both.result === "undecided" ? both.reason : "", /^every model failed: gpt-6\.1-sol: bad request .*; other: overloaded$/);

    const once = model(() => verdictCall([{ index: 1, verdict: "met", reason: "a" }, { index: 2, verdict: "met", reason: "b" }]));
    await new AcceptanceChecker(async () => [once, once]).check(TASK, DIFF);
    assert.equal(once.requests.length, 1, "the same model isn't asked twice");

    const garbled = model(() => reply([text("I think it's fine")], "end_turn"));
    const spare = model(() => assert.fail("an answer, however bad, isn't a failed call"), "spare");
    assert.equal((await new AcceptanceChecker(async () => [garbled, spare]).check(TASK, DIFF)).result, "undecided");
  });

  it("tells the agent what's missing, and the reviewer what was checked", () => {
    const criteria = [
      { criterion: "GET /api/llm answers the status", verdict: "met" as const, reason: "routed" },
      { criterion: "The llm-none scenario answers 404", verdict: "unmet" as const, reason: "no such scenario" },
    ];
    assert.equal(unmetReason(criteria), "Acceptance check: 1 of 2 criteria not met.\n- The llm-none scenario answers 404\n  Missing: no such scenario\nDo these before finishing; the tests passing isn't enough.");
    const note = acceptanceNote({ commit: "c", acceptance: { result: "met", commit: "c", at: "t", model: "claude-opus-5-5", summary: "Done.", criteria: [criteria[0], { ...criteria[1], verdict: "unclear" }] } });
    assert.deepEqual(note, [
      "**Acceptance check** (claude-opus-5-5): 1 of 2 criteria met, 1 unclear. Done.",
      "- ✅ GET /api/llm answers the status",
      "- ❔ The llm-none scenario answers 404: no such scenario",
    ]);
    assert.deepEqual(acceptanceNote({ commit: "newer", acceptance: { result: "met", commit: "c", at: "t", criteria: [] } }), [], "only for the commit under review");
    assert.match(acceptanceNote({ commit: "c", acceptance: { result: "undecided", commit: "c", at: "t", reason: "no model" } })[0], /couldn't decide \(no model\)/);
  });
});

function expectType<T extends AgentMessage["type"]>(m: AgentMessage, type: T): Extract<AgentMessage, { type: T }> {
  assert.equal(m.type, type);
  return m as Extract<AgentMessage, { type: T }>;
}

/** Take the next assignment, push `files`, report done; returns the commit. */
async function implement(ctx: HubContext, w: TestClient, files: Record<string, string>) {
  const assignment = expectType(await w.next(), "TASK_ASSIGNMENT").payload;
  w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: assignment.taskId }));
  const commit = await pushTaskBranch(ctx.gitUrl, assignment.taskId, files);
  w.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: assignment.taskId, commit }));
  return { assignment, commit };
}

/** A rework commit on top of the task's branch, as the agent's next round pushes it. */
async function pushOnTop(gitUrl: string, taskId: string, files: Record<string, string>): Promise<string> {
  const dir = tempDir("aso-rework-");
  await gitAsync(dir, "clone", "--quiet", gitUrl, ".");
  git(dir, "checkout", "--quiet", "-b", `task/${taskId}`, `origin/task/${taskId}`);
  writeFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", `rework ${taskId}`);
  await gitAsync(dir, "push", "--quiet", "origin", `task/${taskId}`);
  return git(dir, "rev-parse", "HEAD");
}

async function passQa(qa: TestClient, commit: string) {
  const run = expectType(await qa.next(), "TEST_EXECUTION").payload;
  assert.equal(run.commit, commit);
  qa.send(createMessage("STATUS_UPDATE", "qa", { state: "in_progress", taskId: run.taskId }));
  qa.send(createMessage("FEEDBACK_LOOP", "qa", { taskId: run.taskId, commit, outcome: "pass", summary: "ok" }));
}

describe("acceptance check in the pipeline", () => {
  it("sends work that misses a criterion back with the reason, then merges the fix", async () => {
    const checks: string[] = [];
    // First commit: criterion 2 unmet; the second: all met.
    const checker = {
      check: async (task: { spec: { acceptanceCriteria: string[] } }, diff: TaskDiff | undefined): Promise<AcceptanceVerdict> => {
        checks.push(diff!.head);
        const second = checks.length > 1;
        const criteria = task.spec.acceptanceCriteria.map((criterion, i) => ({ criterion, verdict: i === 1 && !second ? ("unmet" as const) : ("met" as const), reason: second ? "done" : "no llm-none scenario" }));
        return { result: second ? "met" : "unmet", criteria, summary: "", model: "claude-opus-5-5", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } };
      },
    };
    await withHub(
      async (ctx) => {
        const dev = await worker(ctx.port, "dev");
        const qa = await worker(ctx.port, "qa");
        await postTask(ctx.port, { taskId: "llm", role: "backend", title: "Serve /api/llm", description: "d", acceptanceCriteria: TASK.spec.acceptanceCriteria });
        const first = await implement(ctx, dev, { "llm.txt": "endpoint\n" });
        await passQa(qa, first.commit);

        const back = expectType(await dev.next(5000), "TASK_ASSIGNMENT").payload;
        assert.match(back.rework!.reason, /Acceptance check: 1 of 2 criteria not met\.\n- The llm-none scenario answers 404\n {2}Missing: no llm-none scenario/);
        const task = ctx.hub.tasks.get("llm")!;
        assert.equal(task.acceptance!.result, "unmet");
        assert.ok(task.history.some((h) => h.event === "acceptance check: 1 of 2 criteria met, 1 unmet"));
        assert.equal(task.llm.costUsd, 0.01, "the check's cost counts toward the task");

        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "llm" }));
        const fixed = await pushOnTop(ctx.gitUrl, "llm", { "llm.txt": "endpoint\nllm-none: 404\n" });
        dev.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "llm", commit: fixed }));
        await passQa(qa, fixed);
        await waitFor(() => ctx.hub.tasks.get("llm")?.state === "merged" || undefined);
        assert.equal(ctx.hub.tasks.get("llm")!.acceptance!.result, "met");
        assert.equal(checks.length, 2);
        dev.ws.close();
        qa.ws.close();
      },
      { acceptanceCheck: checker },
    );
  });

  it("skips the check for a task without criteria, and goes on when it can't decide", async () => {
    let called = 0;
    const undecided = { check: async (): Promise<AcceptanceVerdict> => (called++, { result: "undecided", reason: "the model failed: overloaded" }) };
    await withHub(
      async (ctx) => {
        const dev = await worker(ctx.port, "dev");
        const qa = await worker(ctx.port, "qa");
        await postTask(ctx.port, { taskId: "plain", role: "backend", title: "No criteria", description: "d" });
        const a = await implement(ctx, dev, { "a.txt": "a\n" });
        await passQa(qa, a.commit);
        await waitFor(() => ctx.hub.tasks.get("plain")?.state === "merged" || undefined);
        assert.equal(called, 0, "nothing to check");

        await postTask(ctx.port, { taskId: "crit", role: "backend", title: "With criteria", description: "d", acceptanceCriteria: ["says hello"] });
        const b = await implement(ctx, dev, { "b.txt": "b\n" });
        await passQa(qa, b.commit);
        await waitFor(() => ctx.hub.tasks.get("crit")?.state === "merged" || undefined);
        assert.equal(called, 1);
        assert.ok(ctx.hub.tasks.get("crit")!.history.some((h) => /acceptance check undecided \(the model failed: overloaded\); going on/.test(h.event)));
        dev.ws.close();
        qa.ws.close();
      },
      { acceptanceCheck: undecided },
    );
  });
});
