import { DIAGNOSIS_ACTION_LABEL, DIAGNOSIS_CAUSE_LABEL, DIAGNOSIS_SOURCE_LABEL, hubHttpBase, type Diagnosis } from "@aso/shared";
import { api } from "../hub-api.js";

export interface TaskDiagnosisOptions {
  hub: string;
  accept?: boolean;
  refuse?: boolean;
  again?: boolean;
}

interface TaskView {
  state: string;
  retries?: number;
  diagnosis?: Diagnosis;
}

/** What `aso task-diagnosis` prints: the cause, the evidence (marking quotes the Hub didn't find), the proposal. */
export function diagnosisText(task: TaskView): string {
  const d = task.diagnosis;
  if (!d) return task.state === "failed" ? "no diagnosis yet; `--again` asks the product owner" : `the task is ${task.state}; only failed tasks are diagnosed`;
  if (d.state === "diagnosing") return "the product owner is reading why it failed…";
  if (d.state === "failed") return `the product owner couldn't diagnose it: ${d.error ?? "no reason"}`;
  const p = d.proposal;
  const lines = [d.cause ? DIAGNOSIS_CAUSE_LABEL[d.cause] : "Diagnosis", d.summary ?? "", ""];
  for (const e of d.evidence ?? []) lines.push(`${e.found ? " " : "!"} [${DIAGNOSIS_SOURCE_LABEL[e.source]}] ${e.quote}${e.note ? `\n    ${e.note}` : ""}`);
  if (d.evidence?.some((e) => !e.found)) lines.push("  (! = the Hub didn't find this quote in that source)");
  if (p) {
    lines.push("", `Proposes: ${DIAGNOSIS_ACTION_LABEL[p.action]}. ${p.why}`);
    if (p.description) lines.push(`  description: ${p.description}`);
    for (const c of p.acceptanceCriteria ?? []) lines.push(`  - ${c}`);
    if (p.issue) lines.push(`  issue: ${p.issue.title}`, ...p.issue.body.split("\n").map((l) => `    ${l}`));
  }
  // The Hub's isCurrentDiagnosis: a diagnosis of the failure the task is in now.
  const current = task.state === "failed" && d.attempt === (task.retries ?? 0);
  if (d.decision) lines.push("", `you ${d.decision.kind} it`);
  else if (!current) lines.push("", "(of an earlier failure)");
  else if (p) lines.push("", "answer with --accept or --refuse");
  const footer = [d.model, d.costUsd !== undefined ? `$${d.costUsd.toFixed(2)}` : undefined].filter((x): x is string => x !== undefined);
  if (footer.length) lines.push(footer.join(" · "));
  return lines.join("\n").trim();
}

export async function taskDiagnosisCommand(taskId: string, opts: TaskDiagnosisOptions): Promise<void> {
  const base = hubHttpBase(opts.hub);
  const chosen = [opts.accept && "accept", opts.refuse && "refuse", opts.again && "again"].filter(Boolean);
  if (chosen.length > 1) throw new Error("use one of --accept, --refuse and --again");
  const path = `/api/tasks/${encodeURIComponent(taskId)}`;
  if (opts.again) {
    await api(base, `${path}/diagnose`, { method: "POST" });
    return console.log("asked the product owner; run this again shortly for its answer");
  }
  const task = await api<TaskView>(base, opts.accept ? `${path}/diagnosis/accept` : opts.refuse ? `${path}/diagnosis/refuse` : path, opts.accept || opts.refuse ? { method: "POST" } : undefined);
  console.log(diagnosisText(task));
  if (opts.accept) console.log(`\naccepted: the task is now ${task.state}`);
}
