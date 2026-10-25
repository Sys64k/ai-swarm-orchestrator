import { createLogger } from "@aso/shared";
import type { HubRepository } from "./hub-repo.js";

const log = createLogger("branches");

/**
 * Which task branches to delete: those of merged tasks, and those no task owns whose tip is
 * already in main (left from before the Hub deleted branches on merge). A failed, cancelled or
 * running task keeps its branch: its unfinished work is there.
 */
export function mergedTaskBranches(
  branches: ReadonlyMap<string, string>,
  stateOf: (taskId: string) => string | undefined,
  inMain: ReadonlySet<string>,
): string[] {
  return [...branches].filter(([taskId, tip]) => {
    const state = stateOf(taskId);
    return state === "merged" || (state === undefined && inMain.has(tip));
  }).map(([taskId]) => taskId);
}

/** Delete the task branches `mergedTaskBranches` picks, once, when a project opens. */
export async function pruneMergedTaskBranches(repo: HubRepository, stateOf: (taskId: string) => string | undefined): Promise<number> {
  const branches = await repo.taskBranches();
  const unowned = [...branches].filter(([taskId]) => stateOf(taskId) === undefined).map(([, tip]) => tip);
  const inMain = new Set<string>();
  for (const tip of unowned) if (await repo.isInMain(tip)) inMain.add(tip);
  const doomed = mergedTaskBranches(branches, stateOf, inMain);
  for (const taskId of doomed) await repo.forgetMergedBranch(taskId, branches.get(taskId));
  if (doomed.length) log.info(`deleted ${doomed.length} merged task branch${doomed.length === 1 ? "" : "es"} in ${repo.dir}`);
  return doomed.length;
}
