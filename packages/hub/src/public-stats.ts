import type { PublicStats, PublicStatsShare, TrackRecords } from "@aso/shared";
import { trackRecords, type ReportPlan, type ReportTask } from "./job-report.js";

/** How long a public answer is reused, by the Hub and by caches in between. */
export const PUBLIC_STATS_CACHE_SEC = 300;

type Row = TrackRecords["rows"][number];

/** A row's whole model cost: its builds, its plans as the Architect, its checks as the reviewer. */
const costOf = (r: Row) => r.costUsd + r.plans.costUsd + r.reviews.costUsd;
const roundUsd = (usd: number) => Math.round(usd * 100) / 100;

/**
 * A model's name fit to publish. A machine's own model (`machine/<name>`) would name what runs on
 * a volunteer's machine, so it is only "a machine's own model"; other names keep the characters
 * model names use, nothing that could carry markup.
 */
export function publicModelName(spec: string): string {
  if (spec.startsWith("machine/")) return "a machine's own model";
  return spec.replace(/[^A-Za-z0-9._:/@+ -]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "a model";
}

/**
 * What the Hub shares publicly (`--public-stats`), made from its track records by model: totals,
 * and per model and costs only when chosen. An allow-list of fields: never machines, desks,
 * people, projects or task titles. Pure.
 */
export function publicStats(byModel: TrackRecords, parts: PublicStatsShare["parts"], at: string): PublicStats {
  const rows = byModel.rows;
  const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
  const finished = sum((r) => r.tasks.finished);
  const totalUsd = sum(costOf);
  const shareCosts = parts.includes("costs");
  return {
    since: byModel.since,
    at,
    tasks: { finished, firstTry: sum((r) => r.tasks.firstTry), tookOver: sum((r) => r.tasks.tookOver) },
    plans: { proposed: sum((r) => r.plans.proposed), approved: sum((r) => r.plans.approved) },
    ...(shareCosts ? { costs: { totalUsd: roundUsd(totalUsd), ...(finished ? { perTaskUsd: roundUsd(totalUsd / finished) } : {}) } } : {}),
    ...(parts.includes("models")
      ? {
          models: rows.map((r) => ({
            model: publicModelName(r.key),
            finished: r.tasks.finished,
            firstTry: r.tasks.firstTry,
            tookOver: r.tasks.tookOver,
            builds: r.builds.jobs,
            qaPassed: r.builds.qaPassed,
            qaFailed: r.builds.qaFailed,
            accepted: r.builds.accepted,
            unmet: r.builds.unmet,
            plansProposed: r.plans.proposed,
            plansApproved: r.plans.approved,
            checks: r.reviews.checks,
            checksMet: r.reviews.met,
            ...(shareCosts
              ? { costUsd: roundUsd(costOf(r)), ...(r.costPerFinishedUsd !== undefined ? { costPerTaskUsd: roundUsd(r.costPerFinishedUsd) } : {}) }
              : {}),
          })),
        }
      : {}),
  };
}

/** The public stats of the projects shared (all, unless `share.projects` names some). */
export function publicStatsFor(tasks: readonly ReportTask[], plans: readonly ReportPlan[], share: PublicStatsShare, at: string): PublicStats {
  const inScope = <T extends { project: string }>(list: readonly T[]) => (share.projects?.length ? list.filter((x) => share.projects!.includes(x.project)) : list);
  return publicStats(trackRecords(inScope(tasks), inScope(plans), { by: "model" }), share.parts, at);
}
