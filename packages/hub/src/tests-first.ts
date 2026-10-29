import type { TestsFirst, WorkerRole } from "@aso/shared";

/**
 * Tests-first tasks (spec.testsFirst): the test writer (the Architect's model, in QA's role)
 * writes the tests first; a builder then makes them pass without changing them. The rules on
 * which phase a task is in, kept here so the task pipeline, the prompts and the model routing agree.
 */
interface Phased {
  testsFirst?: TestsFirst;
}

/** The tests a builder may not change: those written first, since the test writer's commit. */
export interface LockedTests {
  since: string;
  files: readonly string[];
}

/** Whether the task's agent writes its tests now (the first phase). */
export function writingTests(task: Phased): boolean {
  return task.testsFirst?.phase === "tests";
}

/** Whether a builder works against tests written first (the second phase). */
export function buildingToPassTests(task: Phased): task is Phased & { testsFirst: TestsFirst & { phase: "build" } } {
  return task.testsFirst?.phase === "build";
}

/** The role its agent works in: QA's (test files only) while writing tests first, else the task's own. */
export function roleOf(task: Phased & { spec: { role: WorkerRole } }): WorkerRole {
  return writingTests(task) ? "qa" : task.spec.role;
}

/** The tests push verification keeps a builder from changing, or none. */
export function lockedTests(task: Phased): LockedTests | undefined {
  const t = task.testsFirst;
  return buildingToPassTests(task) && t!.commit && t!.files.length ? { since: t!.commit, files: t!.files } : undefined;
}

/** Whether the builder may still dispute the tests (dispute_tests): once per task. */
export function mayDispute(task: Phased): boolean {
  return buildingToPassTests(task) && !task.testsFirst.disputed;
}

/** Whether a builder's dispute sends the tests back to their writer; a second one is an ordinary give-up. */
export function canDispute(task: Phased, disputesTests: boolean | undefined): boolean {
  return !!disputesTests && mayDispute(task);
}
