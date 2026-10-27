import { agentName, COUNTED_BUILD_RESULTS, type JobRecord, type TaskState, type TrackRecordQuery, type TrackRecordRow, type TrackRecords } from "@aso/shared";

/**
 * Track records, rebuilt from the tasks' job records (`jobs.ts`): how each model, machine, desk,
 * role or project has done. Not to be confused with a worker key's running tally
 * (`track-record.ts`), which counts outcomes per key as they happen, for deciding how far to
 * trust a machine you don't control; this report covers every job, whoever's machine ran it.
 */

/** What the report needs of a task. */
export interface ReportTask {
  project: string;
  state: TaskState;
  spec: { role: string };
  jobs?: JobRecord[];
}

/** The report's costs, to a hundredth of a cent (the records keep a millionth of a dollar). */
const roundUsd = (usd: number) => Math.round(usd * 1e4) / 1e4;

function emptyRow(key: string): TrackRecordRow {
  return {
    key,
    builds: { jobs: 0, built: 0, unverified: 0, failed: 0, outOfTurns: 0, modelRefused: 0, dropped: 0, cancelled: 0, qaPassed: 0, qaFailed: 0, accepted: 0, unmet: 0 },
    qaRuns: { runs: 0, passed: 0, failed: 0, errors: 0, dropped: 0 },
    tasks: { worked: 0, finished: 0, firstTry: 0, tookOver: 0 },
    costUsd: 0,
  };
}

/** Who a job counts for. Undefined: it doesn't count in this grouping (a QA run has no model). */
function keyOf(job: JobRecord, task: ReportTask, by: TrackRecordQuery["by"]): string | undefined {
  switch (by) {
    case "model":
      return job.job === "implement" ? (job.model ?? "unknown model") : undefined;
    case "host":
      return job.host;
    case "desk":
      return agentName(job);
    case "role":
      return task.spec.role;
    case "project":
      return task.project;
  }
}

/** A job that has ended (a build still being checked, `pushed`, hasn't). */
const ended = (j: JobRecord) => !!j.endedAt && !!j.result && j.result !== "pushed";
const startedSince = (j: JobRecord, since: string | undefined) => !since || Date.parse(j.startedAt) >= Date.parse(since);

function countBuild(row: TrackRecordRow, job: JobRecord): void {
  const b = row.builds;
  b.jobs++;
  for (const result of COUNTED_BUILD_RESULTS) if (job.result === result) b[result]++;
  if (job.qa === "passed") b.qaPassed++;
  if (job.qa === "failed") b.qaFailed++;
  if (job.acceptance === "met") b.accepted++;
  if (job.acceptance === "unmet") b.unmet++;
  row.costUsd += job.costUsd;
}

function countQaRun(row: TrackRecordRow, job: JobRecord): void {
  const q = row.qaRuns;
  q.runs++;
  if (job.result === "passed") q.passed++;
  else if (job.result === "qaFailed") q.failed++;
  else if (job.result === "error") q.errors++;
  else if (job.result === "dropped") q.dropped++;
}

/**
 * Who finished a merged task: whoever made its last build that checked out. Judged over all its
 * builds, so a time filter can't turn a reworked task into a first try. `firstTry`: that was its
 * only build; `tookOver`: someone else had built on it before.
 */
function finishedBy(task: ReportTask, by: TrackRecordQuery["by"]): { key: string; build: JobRecord; firstTry: boolean; tookOver: boolean } | undefined {
  if (task.state !== "merged") return undefined;
  const builds = (task.jobs ?? []).filter((j) => j.job === "implement" && ended(j));
  const build = [...builds].reverse().find((j) => j.result === "built");
  const key = build && keyOf(build, task, by);
  if (!build || key === undefined) return undefined;
  return { key, build, firstTry: builds.length === 1, tookOver: builds.some((j) => j !== build && keyOf(j, task, by) !== key) };
}

/**
 * Track records: per model, machine, desk, role or project, what came of its ended builds and
 * QA runs, the tasks it built on and finished, and their cost.
 */
export function trackRecords(tasks: readonly ReportTask[], query: TrackRecordQuery): TrackRecords {
  const rows = new Map<string, TrackRecordRow>();
  const worked = new Map<string, Set<ReportTask>>();
  const rowOf = (key: string) => rows.get(key) ?? rows.set(key, emptyRow(key)).get(key)!;
  const workedOn = (key: string) => worked.get(key) ?? worked.set(key, new Set()).get(key)!;
  let since: string | undefined;

  for (const task of tasks) {
    if (query.project && task.project !== query.project) continue;
    if (query.role && task.spec.role !== query.role) continue;
    for (const job of (task.jobs ?? []).filter((j) => ended(j) && startedSince(j, query.since))) {
      const key = keyOf(job, task, query.by);
      if (key === undefined) continue;
      if (!since || job.startedAt < since) since = job.startedAt;
      if (job.job === "implement") {
        countBuild(rowOf(key), job);
        workedOn(key).add(task);
      } else {
        countQaRun(rowOf(key), job);
      }
    }
    const finished = finishedBy(task, query.by);
    if (!finished || !startedSince(finished.build, query.since)) continue;
    const t = rowOf(finished.key).tasks;
    t.finished++;
    if (finished.firstTry) t.firstTry++;
    if (finished.tookOver) t.tookOver++;
  }

  for (const [key, set] of worked) rowOf(key).tasks.worked = set.size;
  const out = [...rows.values()].map((r) => ({
    ...r,
    costUsd: roundUsd(r.costUsd),
    ...(r.tasks.finished ? { costPerFinishedUsd: roundUsd(r.costUsd / r.tasks.finished) } : {}),
  }));
  out.sort((a, b) => b.tasks.finished - a.tasks.finished || b.builds.jobs - a.builds.jobs || b.qaRuns.runs - a.qaRuns.runs || a.key.localeCompare(b.key));
  return { by: query.by, since: since ?? null, rows: out };
}
