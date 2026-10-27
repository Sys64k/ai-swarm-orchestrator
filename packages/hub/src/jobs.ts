import type { JobRecord, JobResult } from "@aso/shared";

/**
 * The bookkeeping of a task's jobs (`TaskRecord.jobs`): one record per build and per QA run,
 * from its start on a desk to its result, with the verdicts on a build's work. Pure: the task
 * manager calls these where jobs start and end; `job-report.ts` reads the records.
 */

/** Job records kept per task (each is small; a task rarely has more than a dozen). */
export const JOBS_LIMIT = 200;

export type JobKind = JobRecord["job"];

/** Where a job runs. */
export interface Desk {
  host: string;
  slot: number;
  nodeId: string;
}

/** The job of this kind under way, if any. */
export function openJob(jobs: readonly JobRecord[] | undefined, kind: JobKind): JobRecord | undefined {
  const last = [...(jobs ?? [])].reverse().find((j) => j.job === kind);
  return last && !last.endedAt ? last : undefined;
}

/** The latest build. */
export function lastBuild(jobs: readonly JobRecord[] | undefined): JobRecord | undefined {
  return [...(jobs ?? [])].reverse().find((j) => j.job === "implement");
}

/** End the open job of this kind, if there is one. */
export function endJob(jobs: readonly JobRecord[] | undefined, kind: JobKind, result: JobResult, now: string): void {
  const open = openJob(jobs, kind);
  if (!open) return;
  open.endedAt = now;
  open.result = result;
}

/**
 * A job begins on a desk. The same desk reporting again on its open job (after a reconnect)
 * doesn't start another; a job left open on another desk ends as dropped. Returns the list,
 * created if needed and trimmed to `JOBS_LIMIT`.
 */
export function startJob(jobs: JobRecord[] | undefined, kind: JobKind, desk: Desk, round: number, now: string): JobRecord[] {
  const list = jobs ?? [];
  const open = openJob(list, kind);
  if (open?.nodeId === desk.nodeId && open.slot === desk.slot) return list;
  if (open) endJob(list, kind, "dropped", now);
  list.push({ job: kind, round, host: desk.host, slot: desk.slot, nodeId: desk.nodeId, startedAt: now, calls: 0, costUsd: 0 });
  if (list.length > JOBS_LIMIT) list.splice(0, list.length - JOBS_LIMIT);
  return list;
}

/** A model call by the open build's agent: its count and cost (rounded like the task's). */
export function addBuildUsage(jobs: readonly JobRecord[] | undefined, costUsd: number): void {
  const build = openJob(jobs, "implement");
  if (!build) return;
  build.calls++;
  build.costUsd = Math.round((build.costUsd + costUsd) * 1e6) / 1e6;
}

/** The pushed build's work checked out, or not. */
export function markVerified(jobs: readonly JobRecord[] | undefined, ok: boolean): void {
  const build = lastBuild(jobs);
  if (build?.result === "pushed") build.result = ok ? "built" : "unverified";
}

/** QA's verdict on the latest build's work. */
export function markQa(jobs: readonly JobRecord[] | undefined, passed: boolean): void {
  const build = lastBuild(jobs);
  if (build) build.qa = passed ? "passed" : "failed";
}

/** The acceptance check's verdict on the latest build's work. */
export function markAcceptance(jobs: readonly JobRecord[] | undefined, result: NonNullable<JobRecord["acceptance"]>): void {
  const build = lastBuild(jobs);
  if (build) build.acceptance = result;
}

/** How a build ended when its worker reported it failed: the model refused, it ran out of turns, or it gave up. */
export function failedBuildResult(task: { switchingModel?: boolean; outOfTurns?: boolean }): JobResult {
  if (task.switchingModel) return "modelRefused";
  if (task.outOfTurns) return "outOfTurns";
  return "failed";
}
