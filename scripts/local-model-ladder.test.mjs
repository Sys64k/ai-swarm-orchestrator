import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BASE_COMMIT, LADDER, ladderTasks, modelTag, resultRow, resultsTable } from "./local-model-ladder.mjs";

describe("the local-model ladder", () => {
  it("names a run after its model", () => {
    assert.equal(modelTag("local/qwen3-coder:30b"), "qwen3-coder-30b");
    assert.equal(modelTag("ollama-cloud/gpt-oss:120b"), "gpt-oss-120b");
    assert.equal(modelTag("devstral:24b"), "devstral-24b");
  });

  it("has five levels in every variant, starting from aso-test before the first ladder", () => {
    for (const [variant, tasks] of Object.entries(LADDER)) assert.equal(tasks.length, 5, variant);
    assert.equal(BASE_COMMIT, "9cac1e3");
  });

  it("pins each task to the model and tags its level, in the run's project", () => {
    const tasks = ladderTasks("local/qwen3-coder:30b", { project: "ladder-qwen3-coder-30b" });
    assert.deepEqual(tasks.map((t) => [t.taskId, t.level]), [1, 2, 3, 4, 5].map((n) => [`ladder-qwen3-coder-30b-l${n}`, n]));
    for (const t of tasks) {
      assert.deepEqual([t.project, t.model, t.role, t.testsFirst], ["ladder-qwen3-coder-30b", "local/qwen3-coder:30b", "frontend", undefined]);
      assert.match(t.acceptanceCriteria.at(-1), /All existing tests still pass/);
    }
    assert.equal(tasks[0].title, "Word count helper", "variant A by default");
    assert.match(tasks[1].description, /60 characters plus the `…`/, "level 2 says the project's convention");
    assert.doesNotMatch(tasks[1].acceptanceCriteria.join("\n"), /still cut to TITLE_MAX_LENGTH after tidying/, "not the criterion two models failed on");
  });

  it("marks a tests-first run's tasks, and refuses a variant it doesn't have", () => {
    const tasks = ladderTasks("local/x", { testsFirst: true, variant: "B" });
    assert.ok(tasks.every((t) => t.testsFirst === true && t.taskId.endsWith("-tf")));
    assert.equal(tasks[0].title, "Reading time helper");
    assert.throws(() => ladderTasks("local/x", { variant: "Z" }), /no variant Z: use A, B, C, D/);
  });

  it("prints the results as a table for the experiment page", () => {
    const task = (state, reworkRound, level, title, costUsd) => ({ state, reworkRound, spec: { level, title }, llm: { costUsd } });
    const rows = [resultRow(task("merged", 0, 1, "Word count helper", 0.01), 4), resultRow(task("merged", 2, 2, "Tidy titles", 0.03), 20), resultRow(task("failed", 3, 3, "Backup", 0.05), 41)];
    assert.deepEqual(rows.map((r) => r.outcome), ["✅ 1st try", "✅ try 3", "❌ failed"]);
    assert.equal(
      resultsTable("local/m", rows, { testsFirst: true }),
      [
        "`local/m` (tests first):",
        "",
        "| Level | Task | Result | Minutes | Cost |",
        "|---|---|---|---|---|",
        "| 1 | Word count helper | ✅ 1st try | 4 | $0.01 |",
        "| 2 | Tidy titles | ✅ try 3 | 20 | $0.03 |",
        "| 3 | Backup | ❌ failed | 41 | $0.05 |",
      ].join("\n"),
    );
  });
});
