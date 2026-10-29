import { agentName, COUNTED_BUILD_RESULTS, type JobRecord, type PlanState, type TaskState, type TrackRecordQuery, type TrackRecordRow, type TrackRecords } from "@aso/shared";

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
  spec: { role: string; level?: number };
  jobs?: JobRecord[];
  /** The plan it came from, whose cost its tasks share. */
  planId?: string;
}

/** What the report needs of a plan. */
export interface ReportPlan {
  planId?: string;
  project: string;
  state: PlanState;
  model?: string;
  dialogue?: ReadonlyArray<{ kind: string }>;
  llm: { costUsd: number };
  createdAt: string;
}

/** A build or plan whose model wasn't recorded (from before models were). */
const UNKNOWN_MODEL = "unknown model";

/** The model a build ran on, by its name. */
const buildModel = (job: JobRecord) => job.model ?? UNKNOWN_MODEL;

/** Whether `model` passes the query's model filter (none: everything does). */
const ofModel = (query: TrackRecordQuery, model: string | undefined) => !query.model || model === query.model;

/** Plans and acceptance checks count by model and by project: they have no machine, desk or role. */
const countsPlansAndReviews = (by: TrackRecordQuery["by"]) => by === "model" || by === "project";

/** The report's costs, to a hundredth of a cent (the records keep a millionth of a dollar). */
const roundUsd = (usd: number) => Math.round(usd * 1e4) / 1e4;

function emptyRow(key: string): TrackRecordRow {
  return {
    key,
    builds: { jobs: 0, built: 0, unverified: 0, failed: 0, outOfTurns: 0, modelRefused: 0, dropped: 0, cancelled: 0, qaPassed: 0, qaFailed: 0, accepted: 0, unmet: 0 },
    qaRuns: { runs: 0, passed: 0, failed: 0, errors: 0, dropped: 0 },
    tasks: { worked: 0, finished: 0, firstTry: 0, tookOver: 0 },
    costUsd: 0,
    started: { settled: 0, finished: 0, costUsd: 0 },
    plans: { planned: 0, proposed: 0, approved: 0, rejected: 0, failed: 0, withQuestions: 0, costUsd: 0 },
    reviews: { checks: 0, met: 0, overturned: 0, unmet: 0, undecided: 0, costUsd: 0 },
  };
}

/** Who a job counts for. Undefined: it doesn't count in this grouping (a QA run has no model). */
function keyOf(job: JobRecord, task: ReportTask, by: TrackRecordQuery["by"]): string | undefined {
  switch (by) {
    case "model":
      return job.job === "implement" ? (job.model ?? UNKNOWN_MODEL) : undefined;
    case "host":
      return job.host;
    case "desk":
      return agentName(job);
    case "role":
      return task.spec.role;
    case "project":
      return task.project;
    case "level":
      return levelKey(task);
  }
}

/** A task's level as track records show it. */
const levelKey = (task: ReportTask) => (task.spec.level ? `level ${task.spec.level}` : "no level");

/** A job that has ended (a build still being checked, `pushed`, hasn't). */
const ended = (j: JobRecord) => !!j.endedAt && !!j.result && j.result !== "pushed";
/** Whether a job (or plan) started in the query's period: at or after `since`, before `until`. */
const inPeriod = (j: Pick<JobRecord, "startedAt">, query: Pick<TrackRecordQuery, "since" | "until">) =>
  (!query.since || Date.parse(j.startedAt) >= Date.parse(query.since)) && (!query.until || Date.parse(j.startedAt) < Date.parse(query.until));

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
 * Who an acceptance check counts for: its model, or the task's project; nobody in other
 * groupings. By model only checks that recorded theirs (builds from before that don't).
 */
function reviewerKey(build: JobRecord, task: ReportTask, by: TrackRecordQuery["by"]): string | undefined {
  if (!build.acceptance || !countsPlansAndReviews(by)) return undefined;
  return by === "model" ? build.acceptanceModel : task.project;
}

function countReview(row: TrackRecordRow, build: JobRecord): void {
  const r = row.reviews;
  r.checks++;
  if (build.acceptance === "met") r.met++;
  else if (build.acceptance === "unmet") r.unmet++;
  else r.undecided++;
  if (build.overturned) r.overturned++;
  r.costUsd += build.acceptanceCostUsd ?? 0;
}

/** Who a plan counts for: the Architect's model, or its project. Undefined: not in this grouping, or never planned. */
function plannerKey(plan: ReportPlan, by: TrackRecordQuery["by"]): string | undefined {
  if ((plan.state === "pending" && !plan.model) || !countsPlansAndReviews(by)) return undefined;
  return by === "model" ? (plan.model ?? UNKNOWN_MODEL) : plan.project;
}

const hasDialogue = (plan: ReportPlan, kind: string) => plan.dialogue?.some((d) => d.kind === kind) ?? false;

/**
 * Whether the Architect got as far as proposing: a proposal in the dialogue, or a state only a
 * proposal leads to (so a plan from before dialogues were kept counts too).
 */
function reachedProposal(plan: ReportPlan): boolean {
  return hasDialogue(plan, "proposal") || plan.state === "proposed" || plan.state === "approved" || plan.state === "rejected";
}

function countPlan(row: TrackRecordRow, plan: ReportPlan): void {
  const p = row.plans;
  p.planned++;
  if (reachedProposal(plan)) p.proposed++;
  if (plan.state === "approved") p.approved++;
  if (plan.state === "rejected") p.rejected++;
  if (plan.state === "failed") p.failed++;
  if (hasDialogue(plan, "questions")) p.withQuestions++;
  p.costUsd += plan.llm.costUsd;
}

/** The plans a query covers: its project and model, in its period; none with a role or level filter (plans have neither). */
function plansInScope(plans: readonly ReportPlan[], query: TrackRecordQuery): ReportPlan[] {
  if (query.role || query.level) return [];
  return plans.filter(
    (p) => (!query.project || p.project === query.project) && ofModel(query, p.model ?? UNKNOWN_MODEL) && inPeriod({ startedAt: p.createdAt }, query),
  );
}

/** A task's builds that have ended, oldest first. */
function endedBuilds(task: ReportTask): JobRecord[] {
  return (task.jobs ?? []).filter((j) => j.job === "implement" && ended(j));
}

/**
 * Who finished a merged task: whoever made its last build that checked out. Judged over all its
 * builds, so a time filter can't turn a reworked task into a first try. `firstTry`: that was its
 * only build; `tookOver`: someone else had built on it before.
 */
function finishedBy(task: ReportTask, by: TrackRecordQuery["by"]): { key: string; build: JobRecord; firstTry: boolean; tookOver: boolean } | undefined {
  if (task.state !== "merged") return undefined;
  const builds = endedBuilds(task);
  const build = [...builds].reverse().find((j) => j.result === "built");
  const key = build && keyOf(build, task, by);
  if (!build || key === undefined) return undefined;
  return { key, build, firstTry: builds.length === 1, tookOver: builds.some((j) => j !== build && keyOf(j, task, by) !== key) };
}

/** Whether a task's cost is final: merged or failed. Cancelled isn't counted: a person stopped it, not the model. */
function settled(task: ReportTask): boolean {
  return task.state === "merged" || task.state === "failed";
}

/**
 * Each plan's cost per task it led to: shared equally among all its tasks (whatever a query
 * filters), so a plan's cost is counted once over them.
 */
function planShares(tasks: readonly ReportTask[], plans: readonly ReportPlan[]): (task: ReportTask) => number {
  const counts = new Map<string, number>();
  for (const t of tasks) if (t.planId) counts.set(t.planId, (counts.get(t.planId) ?? 0) + 1);
  const shares = new Map<string, number>();
  for (const p of plans) {
    const n = p.planId ? counts.get(p.planId) : undefined;
    if (p.planId && n) shares.set(p.planId, p.llm.costUsd / n);
  }
  return (task) => (task.planId ? (shares.get(task.planId) ?? 0) : 0);
}

/**
 * Where a settled task started, and all it cost: its first build's key (a task's own role or
 * project for those groupings), and every build on any model, their acceptance checks and its
 * share of its plan. Undefined: not settled, never built, or first built outside the query's
 * period or on another model than its.
 */
function startedBy(task: ReportTask, query: TrackRecordQuery, planShare: number): { key: string; costUsd: number } | undefined {
  if (!settled(task)) return undefined;
  const builds = endedBuilds(task);
  const first = builds[0];
  const key = first && keyOf(first, task, query.by);
  if (!first || key === undefined || !inPeriod(first, query) || !ofModel(query, buildModel(first))) return undefined;
  return { key, costUsd: builds.reduce((sum, j) => sum + j.costUsd + (j.acceptanceCostUsd ?? 0), planShare) };
}

function countStarted(row: TrackRecordRow, task: ReportTask, costUsd: number): void {
  const s = row.started;
  s.settled++;
  if (task.state === "merged") s.finished++;
  s.costUsd += costUsd;
}

/**
 * Track records: per model, machine, desk, role, project or task level, what came of its ended builds and
 * QA runs, the tasks it built on and finished, and their cost. By model and by project also the
 * plans made (the Architect's model) and the acceptance checks made (the reviewer's model).
 * With a model filter, only that model's work: by machine, say, how it did on each.
 */
export function trackRecords(tasks: readonly ReportTask[], plans: readonly ReportPlan[], query: TrackRecordQuery): TrackRecords {
  const rows = new Map<string, TrackRecordRow>();
  const worked = new Map<string, Set<ReportTask>>();
  const rowOf = (key: string) => rows.get(key) ?? rows.set(key, emptyRow(key)).get(key)!;
  const workedOn = (key: string) => worked.get(key) ?? worked.set(key, new Set()).get(key)!;
  let since: string | undefined;
  const planShareOf = planShares(tasks, plans);

  for (const task of tasks) {
    if (query.project && task.project !== query.project) continue;
    if (query.role && task.spec.role !== query.role) continue;
    if (query.level && task.spec.level !== query.level) continue;
    const started = startedBy(task, query, planShareOf(task));
    if (started) countStarted(rowOf(started.key), task, started.costUsd);
    for (const job of (task.jobs ?? []).filter((j) => ended(j) && inPeriod(j, query))) {
      const key = keyOf(job, task, query.by);
      if (key === undefined) continue;
      const counted = () => {
        if (!since || job.startedAt < since) since = job.startedAt;
      };
      if (job.job === "implement") {
        if (ofModel(query, buildModel(job))) {
          countBuild(rowOf(key), job);
          workedOn(key).add(task);
          counted();
        }
        const reviewer = reviewerKey(job, task, query.by);
        if (reviewer !== undefined && ofModel(query, job.acceptanceModel)) {
          countReview(rowOf(reviewer), job);
          counted();
        }
      } else if (!query.model) {
        countQaRun(rowOf(key), job);
        counted();
      }
    }
    const finished = finishedBy(task, query.by);
    if (!finished || !inPeriod(finished.build, query) || !ofModel(query, buildModel(finished.build))) continue;
    const t = rowOf(finished.key).tasks;
    t.finished++;
    if (finished.firstTry) t.firstTry++;
    if (finished.tookOver) t.tookOver++;
  }

  for (const plan of plansInScope(plans, query)) {
    const key = plannerKey(plan, query.by);
    if (key !== undefined) countPlan(rowOf(key), plan);
  }

  for (const [key, set] of worked) rowOf(key).tasks.worked = set.size;
  const out = [...rows.values()].map((r) => ({
    ...r,
    costUsd: roundUsd(r.costUsd),
    started: {
      ...r.started,
      costUsd: roundUsd(r.started.costUsd),
      ...(r.started.finished ? { costPerFinishedUsd: roundUsd(r.started.costUsd / r.started.finished) } : {}),
    },
    plans: { ...r.plans, costUsd: roundUsd(r.plans.costUsd) },
    reviews: { ...r.reviews, costUsd: roundUsd(r.reviews.costUsd) },
    ...(r.tasks.finished ? { costPerFinishedUsd: roundUsd(r.costUsd / r.tasks.finished) } : {}),
  }));
  out.sort(
    (a, b) =>
      b.tasks.finished - a.tasks.finished ||
      b.builds.jobs - a.builds.jobs ||
      b.plans.planned - a.plans.planned ||
      b.reviews.checks - a.reviews.checks ||
      b.qaRuns.runs - a.qaRuns.runs ||
      a.key.localeCompare(b.key),
  );
  return { by: query.by, since: since ?? null, rows: out };
}
