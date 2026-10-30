import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failedToDismiss } from "../dist/commands/task-dismiss.js";

describe("aso task-dismiss --failed", () => {
  it("picks the failed tasks still needing someone, in one project or all", () => {
    const t = (id: string, project: string, state: string, extra = {}) => ({ project, state, spec: { taskId: id }, ...extra });
    const tasks = [
      t("a", "aso-test", "failed"),
      t("b", "aso-test", "merged"),
      t("c", "aso-test", "failed", { dismissedAt: "2026-10-30T16:00:00.000Z" }),
      t("d", "aso-test", "failed", { supersededBy: "e" }),
      t("f", "aso-ui", "failed"),
      t("g", "aso-ui", "cancelled"),
    ];
    assert.deepEqual(failedToDismiss(tasks, "aso-test"), ["a"]);
    assert.deepEqual(failedToDismiss(tasks), ["a", "f"]);
  });
});
