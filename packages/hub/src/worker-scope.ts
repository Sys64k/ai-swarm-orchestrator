/**
 * What a worker key may do beyond worker work in general: which projects, whether its machine is
 * trusted, and how much model spending its jobs may cause. Machines connected with the Hub's own
 * token have no scope: they are fully trusted. All the rules are here.
 */
export interface KeyScope {
  /** The projects its machine may clone and work on; undefined: all. */
  projects?: readonly string[];
  /**
   * A trusted machine runs QA. An untrusted one (someone else's) only builds, so its work is
   * always tested by a trusted machine.
   */
  trusted: boolean;
  /** USD of model calls its jobs may cause in total; undefined: no cap beyond task budgets. */
  budgetUsd?: number;
  /** USD its jobs have caused so far (estimated). */
  spentUsd: number;
}

/** A job the Hub is about to give a machine. */
export interface WorkerJob {
  project: string;
  /** `implement`: build the task; `test`: run QA on someone's work. */
  job: "implement" | "test";
}

/** Whether a key may use a project at all (its Git, its jobs). */
export function mayUseProject(scope: KeyScope | undefined, project: string): boolean {
  return !scope?.projects || scope.projects.includes(project);
}

/** Why a key's jobs may make no more model calls; undefined: they may. */
export function budgetSpent(scope: KeyScope | undefined): string | undefined {
  if (scope?.budgetUsd === undefined || scope.spentUsd < scope.budgetUsd) return undefined;
  return `this machine's model budget ($${scope.budgetUsd}) is used up`;
}

/** Why a machine with this key may not take `job`; undefined: it may. `undefined` scope: the Hub's own token. */
export function refuseJob(scope: KeyScope | undefined, job: WorkerJob): string | undefined {
  if (!scope) return undefined;
  if (!mayUseProject(scope, job.project)) return `its key is limited to ${scope.projects!.join(", ")}`;
  if (job.job === "test" && !scope.trusted) return "an untrusted machine doesn't run QA";
  return budgetSpent(scope);
}

/**
 * The scope of a machine whose owner is a worker key that no longer exists: nothing allowed.
 * (Machines on the Hub's own token have no owner key and no scope: fully trusted.)
 */
export const REFUSE_ALL: KeyScope = Object.freeze({ projects: [], trusted: false, budgetUsd: 0, spentUsd: 0 });

/** A scope in words, for logs and `aso worker-keys`: "untrusted, projects aso-ui, $1.20 of $10 spent". */
export function describeScope(s: Pick<KeyScope, "projects" | "budgetUsd"> & { trusted?: boolean; spentUsd?: number }): string {
  const spent = s.spentUsd ?? 0;
  const projects = s.projects ? `projects ${s.projects.join(", ")}` : "all projects";
  const budget = s.budgetUsd !== undefined ? `, $${spent.toFixed(2)} of $${s.budgetUsd} spent` : spent ? `, $${spent.toFixed(2)} spent` : "";
  return `${s.trusted === false ? "untrusted" : "trusted"}, ${projects}${budget}`;
}

/** The project a Git request is for (`<gitPath>/<project>.git/...`); undefined when the path isn't one. */
export function projectOfGitPath(path: string, gitPath: string): string | undefined {
  if (!path.startsWith(`${gitPath}/`)) return undefined;
  return /^([A-Za-z0-9][A-Za-z0-9._-]*)\.git(\/|$)/.exec(path.slice(gitPath.length + 1))?.[1];
}
