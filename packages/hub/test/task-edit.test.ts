import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { correctTask } from "@aso/hub";
import type { TaskSpec } from "@aso/shared";

const SPEC: TaskSpec = {
  taskId: "list",
  role: "frontend",
  kind: "feature",
  title: "List",
  description: "Wide list",
  acceptanceCriteria: ["blog below shop", "no sideways scroll"],
  files: [],
  dependsOn: [],
};

describe("correcting a task before a retry", () => {
  it("changes only what differs, says what changed, and keeps the old text for the history", () => {
    const both = correctTask(SPEC, { description: "Wide list, order kept", acceptanceCriteria: ["keeps the order"] });
    assert.deepEqual([both.spec.description, both.spec.acceptanceCriteria, both.spec.title], ["Wide list, order kept", ["keeps the order"], "List"]);
    assert.equal(both.brief, " A person corrected the task since: its description and its acceptance criteria changed. Work to the task as it is now; where your branch follows the old text, change it.");
    assert.deepEqual(both.history, ["description corrected by a person; it was: Wide list", 'acceptance criteria corrected by a person; they were: "blog below shop", "no sideways scroll"']);
    assert.deepEqual(correctTask({ ...SPEC, acceptanceCriteria: [] }, { acceptanceCriteria: ["a"] }).history, ["acceptance criteria corrected by a person; they were: none"]);
  });

  it("changes nothing for an empty edit or the same text", () => {
    for (const edit of [{}, { description: "Wide list" }, { acceptanceCriteria: ["blog below shop", "no sideways scroll"] }]) {
      const same = correctTask(SPEC, edit);
      assert.deepEqual([same.spec, same.brief, same.history], [SPEC, "", []], JSON.stringify(edit));
    }
  });
});
