import { JOB_OUTCOMES, type JobOutcome } from "@aso/shared";

/**
 * A machine's track record: what became of the jobs its worker key's machine took. Counted as
 * things happen (node ids change on every reconnect, so history can't be rebuilt from tasks).
 * It shows how far to trust a machine you don't control; nothing acts on it by itself. For how
 * every model, machine and desk has done, rebuilt from the tasks' job records, see `job-report.ts`.
 */
export { JOB_OUTCOMES, type JobOutcome };
export type TrackRecord = Partial<Record<JobOutcome, number>>;

/** The record with one more `outcome`. */
export function addOutcome(record: TrackRecord | undefined, outcome: JobOutcome): TrackRecord {
  return { ...record, [outcome]: (record?.[outcome] ?? 0) + 1 };
}

/** A record in words: "12 builds · QA passed 9 of 11 · acceptance met 8 of 9 · 1 failed · 5 QA runs"; "no jobs yet". */
export function describeRecord(r: TrackRecord | undefined): string {
  const n = (k: JobOutcome) => r?.[k] ?? 0;
  const ofTotal = (label: string, good: number, bad: number) => (good + bad ? `${label} ${good} of ${good + bad}` : undefined);
  const parts = [
    n("built") ? `${n("built")} build${n("built") === 1 ? "" : "s"}` : undefined,
    ofTotal("QA passed", n("qaPassed"), n("qaFailed")),
    ofTotal("acceptance met", n("accepted"), n("unmet")),
    n("failed") ? `${n("failed")} failed` : undefined,
    n("dropped") ? `${n("dropped")} dropped` : undefined,
    n("tested") ? `${n("tested")} QA run${n("tested") === 1 ? "" : "s"}` : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "no jobs yet";
}
