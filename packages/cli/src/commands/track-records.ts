import { hubHttpBase, type TrackRecordKey, type TrackRecords } from "@aso/shared";
import { api } from "../hub-api.js";

export interface TrackRecordsOptions {
  hub: string;
  by: TrackRecordKey;
  project?: string;
  role?: string;
  since?: string;
  json?: boolean;
}

const usd = (n: number | undefined) => (n === undefined ? "-" : `$${n.toFixed(2)}`);
/** "9/11": good out of all, or "-" when there were none. */
const ofTotal = (good: number, bad: number) => (good + bad ? `${good}/${good + bad}` : "-");

/** The query string for `GET /api/track-records`. */
export function trackRecordsPath(opts: Pick<TrackRecordsOptions, "by" | "project" | "role" | "since">): string {
  const q = new URLSearchParams({ by: opts.by });
  for (const k of ["project", "role", "since"] as const) if (opts[k]) q.set(k, opts[k]);
  return `/api/track-records?${q.toString()}`;
}

/** Lines of a column table: the header, then each row, aligned. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

/** Builds, the tasks finished and QA runs: a row per key that built or tested anything. */
function workLines(r: TrackRecords): string[] {
  const withQa = r.by !== "model";
  const rows = r.rows.filter((x) => x.builds.jobs || x.qaRuns.runs || x.tasks.finished);
  if (!rows.length) return [];
  return table(
    [r.by.toUpperCase(), "FINISHED", "1ST TRY", "TOOK OVER", "BUILDS", "QA PASSED", "ACCEPTED", "OUT OF TURNS", "FAILED", ...(withQa ? ["QA RUNS PASSED"] : []), "COST", "PER TASK"],
    rows.map((x) => [
      x.key,
      String(x.tasks.finished),
      String(x.tasks.firstTry),
      String(x.tasks.tookOver),
      String(x.builds.jobs),
      ofTotal(x.builds.qaPassed, x.builds.qaFailed),
      ofTotal(x.builds.accepted, x.builds.unmet),
      String(x.builds.outOfTurns),
      String(x.builds.failed),
      ...(withQa ? [ofTotal(x.qaRuns.passed, x.qaRuns.failed)] : []),
      usd(x.costUsd),
      usd(x.costPerFinishedUsd),
    ]),
  );
}

/** Plans and acceptance checks (by model or project): a row per key that planned or reviewed. */
function planLines(r: TrackRecords): string[] {
  const rows = r.rows.filter((x) => x.plans.planned || x.reviews.checks);
  if (!rows.length) return [];
  return table(
    [r.by.toUpperCase(), "PLANS", "PROPOSED", "APPROVED", "REJECTED", "ASKED FIRST", "PLAN COST", "CHECKS", "MET", "UNMET", "UNDECIDED", "CHECK COST"],
    rows.map((x) => [
      x.key,
      String(x.plans.planned),
      String(x.plans.proposed),
      String(x.plans.approved),
      String(x.plans.rejected),
      String(x.plans.withQuestions),
      usd(x.plans.costUsd),
      String(x.reviews.checks),
      String(x.reviews.met),
      String(x.reviews.unmet),
      String(x.reviews.undecided),
      usd(x.reviews.costUsd),
    ]),
  );
}

/** What `aso track-records` prints: the work table, then (by model or project) plans and acceptance checks. */
export function trackRecordLines(r: TrackRecords): string[] {
  const work = workLines(r);
  const plans = planLines(r);
  if (!work.length && !plans.length) return ["No jobs recorded yet: track records count jobs from when the Hub started recording them."];
  const lines = [`Track records by ${r.by}${r.since ? `, from jobs since ${r.since}` : ""}:`];
  if (work.length) {
    lines.push(
      "",
      ...work,
      "",
      "FINISHED: merged tasks it made the last good build of; 1ST TRY: with no build before it; TOOK OVER: after another's builds.",
      "QA PASSED, ACCEPTED: the verdicts on its builds' work. QA RUNS PASSED: its own QA runs that reached a verdict.",
      "COST: its builds' model cost; PER TASK: that per task finished.",
    );
  }
  if (plans.length) {
    lines.push("", "Plans (as the Architect) and acceptance checks (as the reviewer):", "", ...plans, "", "ASKED FIRST: plans where it asked questions before proposing.");
  }
  return lines;
}

/** `aso track-records`. */
export async function trackRecordsCommand(opts: TrackRecordsOptions): Promise<void> {
  const records = await api<TrackRecords>(hubHttpBase(opts.hub), trackRecordsPath(opts));
  console.log(opts.json ? JSON.stringify(records, null, 2) : trackRecordLines(records).join("\n"));
}
