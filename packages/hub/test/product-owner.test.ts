import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import {
  diagnosisPrompt,
  failureSources,
  newFailures,
  ProductOwner,
  readDiagnosis,
  startHub,
  transcriptLine,
  transcriptTail,
  type FailedTask,
  type LlmAdapter,
  type Sources,
} from "@aso/hub";
import { createMessage, type Diagnosis, type TaskDiff } from "@aso/shared";
import { git, makeTargetRepo, reply, ScriptedModel, tempDir, text, TOKEN, toolUse, waitFor, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY;

const TASK: FailedTask = {
  spec: { taskId: "blog", title: "Blog page", description: "List posts below the shop.", acceptanceCriteria: ["Blog is listed below shop", "Tests cover it"] },
  detail: "acceptance check: 1 criterion unmet (gave up after 3 rework rounds)",
  summary: "Done: the blog is below the shop.",
  acceptance: {
    result: "unmet",
    commit: "abc",
    at: "2026-10-31T10:00:00.000Z",
    criteria: [{ criterion: "Blog is listed below shop", verdict: "unmet", reason: "the list is sorted by id, so blog comes first" }],
    qualityNotes: [{ kind: "duplication", note: "copied sort" }],
  },
  history: [
    { at: "2026-10-31T09:00:00.000Z", event: "queued" },
    { at: "2026-10-31T09:30:00.000Z", event: "rework round 3: acceptance check: Blog is listed below shop" },
  ],
};

const DIFF: TaskDiff = {
  base: "a",
  head: "b",
  truncated: false,
  files: [{ path: "lib/projects.ts", status: "modified", additions: 1, deletions: 1, patch: "-  return list.sort(byId);\n+  return list.sort(byId).reverse();" }],
};

const SOURCES: Sources = failureSources(TASK, [], DIFF);

/** The model's answer: a report_diagnosis call with these fields. */
function answer(input: Record<string, unknown>) {
  return reply([toolUse("d1", "report_diagnosis", input)]);
}

const GOOD = {
  cause: "task",
  summary: "The criterion asked for blog below shop, but the list is sorted by id, which puts blog first.",
  evidence: [
    { source: "acceptance", quote: "the list is sorted by id, so blog comes first", note: "the reviewer read the order literally" },
    { source: "diff", quote: "return list.sort(byId).reverse();", note: "the builder reversed the sort to satisfy it" },
    { source: "transcript", quote: "something the transcript never said" },
  ],
  proposal: { action: "retry_with_correction", why: "Ask for the order the code already has.", acceptance_criteria: ["Projects stay sorted by id", "Tests cover it"] },
};

describe("what the product owner reads", () => {
  it("shows each source under its own heading, the agent's summary as a claim", () => {
    const prompt = diagnosisPrompt(TASK, SOURCES);
    assert.match(prompt, /^Task blog failed\./);
    assert.match(prompt, /## Its acceptance criteria \(source: criteria\)\n1\. Blog is listed below shop\n2\. Tests cover it/);
    assert.match(prompt, /## What happened to it, oldest first \(source: history\)\n2026-10-31T09:00:00 queued/);
    assert.match(prompt, /failed: acceptance check: 1 criterion unmet/);
    assert.match(prompt, /- unmet: Blog is listed below shop \(the list is sorted by id, so blog comes first\)/);
    assert.match(prompt, /- note duplication: copied sort/);
    assert.match(prompt, /--- lib\/projects\.ts \(modified, \+1\/-1\)/);
    assert.match(prompt, /a claim, not proof\)\nDone: the blog is below the shop\./);
    assert.doesNotMatch(prompt, /source: transcript|source: qa/, "empty sources are left out");
  });

  it("keeps the end of a long transcript, one compact line per entry, and QA runs apart", () => {
    const at = "2026-10-31T10:00:00.000Z";
    const entries = [
      { seq: 0, at, kind: "event" as const, text: "started" },
      { seq: 1, at, kind: "call" as const, id: "c", name: "run_command", input: { argv: ["npm", "test"] } },
      { seq: 2, at, kind: "result" as const, id: "c", name: "run_command", content: "x".repeat(5000), isError: true },
      { seq: 3, at, kind: "qa" as const, outcome: "fail" as const, summary: "2 tests fail", output: "AssertionError" },
      { seq: 4, at, kind: "text" as const, text: "I'm done." },
    ];
    assert.equal(transcriptLine(entries[1]), '[call run_command] {"argv":["npm","test"]}');
    assert.match(transcriptLine(entries[2]), /^\[result run_command, error\] x+\n… \(2000 characters left out\) …\nx+$/);
    assert.equal(transcriptLine(entries[3]), "[qa fail] 2 tests fail\nAssertionError");
    assert.equal(transcriptTail(entries, 40), "[agent] I'm done.", "only the end fits");
    const sources = failureSources(TASK, entries, undefined);
    assert.equal(sources.qa, "[qa fail] 2 tests fail\nAssertionError");
    assert.doesNotMatch(sources.transcript, /qa fail/);
    assert.equal(sources.diff, "", "no branch to show");
  });

  it("gives test output without its terminal colour codes, so a quote of what it shows is found", () => {
    const at = "2026-11-01T12:00:00.000Z";
    const colored = "Tests  \x1b[1m\x1b[31m4 failed\x1b[39m\x1b[22m | \x1b[1m\x1b[32m508 passed\x1b[39m\x1b[22m (512)";
    const entries = [
      { seq: 0, at, kind: "result" as const, id: "c", name: "run_command", content: colored, isError: true },
      { seq: 1, at, kind: "qa" as const, outcome: "fail" as const, summary: "4 tests fail", output: colored },
    ];
    const sources = failureSources(TASK, entries, undefined);
    assert.match(sources.transcript, /Tests {2}4 failed \| 508 passed \(512\)/);
    assert.doesNotMatch(sources.transcript + sources.qa, /\x1b/);
    const d = readDiagnosis(answer({ ...GOOD, evidence: [{ source: "transcript", quote: "4 failed | 508 passed (512)" }] }).content, sources);
    assert.ok(!("error" in d) && d.evidence?.[0].found);
  });
});

describe("readDiagnosis", () => {
  const read = (input: Record<string, unknown>) => readDiagnosis(answer(input).content, SOURCES);

  it("reads the cause, summary and proposal, and checks every quote against its source", () => {
    const d = read(GOOD);
    assert.ok(!("error" in d));
    assert.equal(d.cause, "task");
    assert.deepEqual(d.proposal, { action: "retry_with_correction", why: "Ask for the order the code already has.", acceptanceCriteria: ["Projects stay sorted by id", "Tests cover it"] });
    assert.deepEqual(d.evidence?.map((e) => e.found), [true, true, false], "a quote not in its source is flagged");
    const spread = read({ ...GOOD, evidence: [{ source: "criteria", quote: "1.   Blog is listed\nbelow shop" }] });
    assert.ok(!("error" in spread) && spread.evidence?.[0].found, "whitespace doesn't matter");
    const elsewhere = read({ ...GOOD, evidence: [{ source: "diff", quote: "Blog is listed below shop" }] });
    assert.ok(!("error" in elsewhere) && elsewhere.evidence?.[0].found === false, "it must be in the source it names");
  });

  it("keeps only what each proposal needs", () => {
    const issue = { issue_title: "QA can't start", issue_body: "npm ci fails" };
    const platform = read({ ...GOOD, cause: "platform", proposal: { action: "platform_issue", why: "w", ...issue, description: "ignored" } });
    assert.ok(!("error" in platform));
    assert.deepEqual(platform.proposal, { action: "platform_issue", why: "w", issue: { title: "QA can't start", body: "npm ci fails" } });
    const retry = read({ ...GOOD, cause: "model", proposal: { action: "retry", why: "w", ...issue, acceptance_criteria: ["x"] } });
    assert.ok(!("error" in retry));
    assert.deepEqual(retry.proposal, { action: "retry", why: "w" });
  });

  it("refuses an answer it can't use", () => {
    assert.deepEqual(readDiagnosis(reply([text("It was the task.")]).content, SOURCES), { error: "the product owner answered without a diagnosis" });
    assert.match((read({ ...GOOD, cause: "weather" }) as { error: string }).error, /missing its cause/);
    assert.match((read({ ...GOOD, proposal: { action: "retry_with_correction", why: "w" } }) as { error: string }).error, /without saying what to change/);
    const many = read({ ...GOOD, evidence: Array.from({ length: 20 }, () => ({ source: "diff", quote: "y".repeat(2000) })) });
    assert.ok(!("error" in many));
    assert.equal(many.evidence?.length, 8);
    assert.equal(many.evidence?.[0].quote.length, 600);
  });
});

describe("ProductOwner", () => {
  const failing: LlmAdapter = { name: "f", model: "down", provider: "x", complete: async () => Promise.reject(new Error("overloaded")) };

  it("asks the next model when one fails, and counts what the answer cost", async () => {
    const model = new ScriptedModel(() => answer(GOOD));
    const { diagnosis, usage } = await new ProductOwner(async () => [failing, undefined, model]).diagnose(TASK, SOURCES, 2);
    assert.equal(diagnosis.state, "ready");
    assert.equal(diagnosis.attempt, 2);
    assert.equal(diagnosis.model, "claude-opus-5-5");
    assert.ok(usage && usage.costUsd > 0 && diagnosis.costUsd === usage.costUsd);
    const none = await new ProductOwner(async () => [failing]).diagnose(TASK, SOURCES, 0);
    assert.deepEqual([none.diagnosis.state, none.diagnosis.error, none.usage], ["failed", "every model failed: down: overloaded", undefined]);
    assert.equal((await new ProductOwner(async () => [undefined]).diagnose(TASK, SOURCES, 0)).diagnosis.error, "no model is configured");
    const unreadable = await new ProductOwner(async () => [new ScriptedModel(() => reply([text("hmm")]))]).diagnose(TASK, SOURCES, 0);
    assert.equal(unreadable.diagnosis.state, "failed");
    assert.ok(unreadable.usage, "an unreadable answer still cost something");
  });

  it("stops for the day once its budget is spent, and is off at 0", async () => {
    let now = new Date("2026-10-31T10:00:00Z");
    const model = new ScriptedModel(() => answer(GOOD));
    const owner = new ProductOwner(async () => [model], { dailyUsd: 0.001, now: () => now });
    assert.equal(owner.unavailable(), undefined);
    await owner.diagnose(TASK, SOURCES, 0);
    assert.equal(owner.unavailable(), "the product owner's budget for today ($0.00) is spent");
    now = new Date("2026-11-01T00:00:01Z");
    assert.equal(owner.unavailable(), undefined, "a new day");
    assert.equal(new ProductOwner(async () => [model], { dailyUsd: 0 }).unavailable(), "the product owner is off");
  });
});

describe("newFailures", () => {
  const t = (id: string, state: string, extra = {}) => ({ spec: { taskId: id }, state, ...extra });

  it("picks tasks that failed since the last look, not old failures or ones nobody waits on", () => {
    const seen = new Map<string, string>();
    assert.deepEqual(newFailures(seen, [t("old", "failed"), t("a", "in_progress"), t("b", "testing"), t("c", "testing"), t("d", "testing")]), [], "first look");
    const diagnosed: Diagnosis = { attempt: 1, state: "ready", at: "2026-10-31T10:00:00.000Z" };
    assert.deepEqual(
      newFailures(seen, [t("old", "failed"), t("a", "failed"), t("b", "failed", { dismissedAt: "x" }), t("c", "failed", { supersededBy: "e" }), t("d", "failed", { retries: 1, diagnosis: diagnosed })]),
      ["a"],
    );
    assert.deepEqual(newFailures(seen, [t("a", "failed")]), [], "once");
    const interrupted = { attempt: 0, state: "diagnosing" as const, at: "2026-10-31T10:00:00.000Z" };
    assert.deepEqual(newFailures(new Map(), [t("cut", "failed", { diagnosis: interrupted }), t("gone", "failed", { diagnosis: interrupted, dismissedAt: "x" })]), ["cut"], "a reading cut off by a restart is made again");
  });
});

describe("the product owner on the Hub", () => {
  const call = (port: number, route: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));

  async function hubWith(model: LlmAdapter, dailyUsd?: number) {
    const root = tempDir("aso-root-");
    const repo = makeTargetRepo();
    git(root, "clone", "--quiet", repo, "shop");
    rmSync(repo, { recursive: true, force: true });
    const hub = await startHub({ projectsRoot: root, port: 0, host: "127.0.0.1", token: TOKEN, sync: { enabled: false }, productOwner: { models: async () => [model], dailyUsd } });
    return { hub, close: async () => (await hub.close(), rmSync(root, { recursive: true, force: true })) };
  }

  async function failTask(port: number, taskId: string) {
    const w = await worker(port, `dev-${taskId}`);
    await call(port, "/api/tasks", { taskId, project: "shop", role: "backend", title: "Blog page", description: "List posts below the shop.", acceptanceCriteria: ["Blog is listed below shop"] });
    assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
    w.send(createMessage("STATUS_UPDATE", `dev-${taskId}`, { state: "failed", taskId, detail: "npm test failed" }));
    return w;
  }

  const diagnosisOf = (port: number, id: string, state: string) =>
    waitFor(async () => {
      const t = (await call(port, `/api/tasks/${id}`)).body;
      return t.diagnosis?.state === state ? t : undefined;
    }, 5000, `diagnosis ${state}`);

  it("diagnoses a failure, tells you, and does what it proposes once you accept", async () => {
    const model = new ScriptedModel(() => answer({ ...GOOD, evidence: [{ source: "history", quote: "npm test failed" }] }));
    const { hub, close } = await hubWith(model);
    try {
      const w = await failTask(hub.port, "blog");
      const task = await diagnosisOf(hub.port, "blog", "ready");
      w.ws.close();
      assert.equal(task.diagnosis.cause, "task");
      assert.deepEqual(task.diagnosis.evidence, [{ source: "history", quote: "npm test failed", found: true }]);
      assert.ok(task.llm.costUsd > 0, "its cost counts on the task");
      assert.match(model.requests[0].messages[0].content as string, /Task blog failed/);
      const notice = (await call(hub.port, "/api/notices")).body.notices[0];
      assert.equal(notice.title, "shop: why it failed");
      assert.match(notice.body, /Proposes: retry it with the task corrected/);

      const accepted = (await call(hub.port, "/api/tasks/blog/diagnosis/accept", {})).body;
      assert.ok(["pending", "assigned"].includes(accepted.state), `retried, not ${accepted.state}`);
      assert.deepEqual(accepted.spec.acceptanceCriteria, ["Projects stay sorted by id", "Tests cover it"]);
      assert.equal(accepted.diagnosis.decision.kind, "accepted");
      assert.equal((await call(hub.port, "/api/tasks/blog/diagnosis/refuse", {})).status, 409, "already answered");
      const record = (await call(hub.port, "/api/product-owner")).body;
      assert.deepEqual([record.diagnosed, record.decisions.accepted, record.retries.accepted], [1, 1, 1], "its track record");
      assert.equal((await call(hub.port, "/api/product-owner?since=soon")).status, 400);
      assert.equal((await call(hub.port, "/api/product-owner?project=elsewhere")).body.diagnosed, 0);
      assert.equal(model.requests.length, 1, "one call per failure");
    } finally {
      await close();
    }
  });

  it("lets you refuse it, ask again, and says when it can't diagnose", async () => {
    let n = 0;
    const model = new ScriptedModel(() => (n++ === 0 ? answer({ ...GOOD, cause: "model", proposal: { action: "dismiss", why: "w" } }) : answer(GOOD)));
    const { hub, close } = await hubWith(model);
    try {
      const w = await failTask(hub.port, "blog");
      await diagnosisOf(hub.port, "blog", "ready");
      w.ws.close();
      const refused = (await call(hub.port, "/api/tasks/blog/diagnosis/refuse", {})).body;
      assert.deepEqual([refused.state, refused.dismissedAt, refused.diagnosis.decision.kind], ["failed", undefined, "refused"], "nothing done");

      assert.equal((await call(hub.port, "/api/tasks/blog/diagnose", {})).body.diagnosis.state, "diagnosing", "asked again");
      const again = await diagnosisOf(hub.port, "blog", "ready");
      assert.equal(again.diagnosis.decision, undefined, "a fresh proposal");
      assert.equal(again.diagnosis.cause, "task");
      assert.equal(again.pastDiagnoses, undefined, "a second reading of the same failure replaces the first");

      await call(hub.port, "/api/tasks", { taskId: "live", project: "shop", role: "backend", title: "t", description: "d" });
      assert.equal((await call(hub.port, "/api/tasks/live/diagnose", {})).status, 409, "only failed tasks");
      assert.equal((await call(hub.port, "/api/tasks/live/diagnosis/accept", {})).status, 409, "no proposal");
      assert.equal((await call(hub.port, "/api/tasks/nope/diagnose", {})).status, 404);
    } finally {
      await close();
    }
  });

  it("records why it didn't diagnose when today's budget is spent", async () => {
    const { hub, close } = await hubWith(new ScriptedModel(() => answer(GOOD)), 0.000001);
    try {
      const w = await failTask(hub.port, "one");
      await diagnosisOf(hub.port, "one", "ready");
      const w2 = await failTask(hub.port, "two");
      const two = await diagnosisOf(hub.port, "two", "failed");
      assert.match(two.diagnosis.error, /budget for today/);
      assert.equal((await call(hub.port, "/api/tasks/two/diagnose", {})).status, 409);
      w.ws.close();
      w2.ws.close();
    } finally {
      await close();
    }
  });
});
