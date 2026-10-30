import { readFile } from "node:fs/promises";
import { hubHttpBase, type RetryTaskBody } from "@aso/shared";
import { api } from "../hub-api.js";

export interface TaskRetryOptions {
  hub: string;
  description?: string;
  criterion?: string[];
  criteriaFile?: string;
}

interface TaskSpecView {
  spec: { description: string; acceptanceCriteria: string[] };
}

/** One criterion per non-empty line, a leading "- " or "1. " dropped: how people list them. */
export function criteriaFromText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^(?:[-*]|\d+[.)])\s+/, ""))
    .filter(Boolean);
}

/** The retry's corrections from the options; empty when the task runs again as it was. */
export function retryBodyFromOptions(opts: Pick<TaskRetryOptions, "description" | "criterion">, criteriaText?: string): RetryTaskBody {
  if (opts.criterion?.length && criteriaText !== undefined) throw new Error("give the criteria with --criterion or --criteria-file, not both");
  const criteria = criteriaText !== undefined ? criteriaFromText(criteriaText) : opts.criterion;
  return { ...(opts.description ? { description: opts.description } : {}), ...(criteria?.length ? { acceptanceCriteria: criteria } : {}) };
}

export async function taskRetryCommand(taskId: string, opts: TaskRetryOptions): Promise<void> {
  const edit = retryBodyFromOptions(opts, opts.criteriaFile ? await readFile(opts.criteriaFile, "utf8") : undefined);
  const path = `/api/tasks/${encodeURIComponent(taskId)}`;
  const before = await api<TaskSpecView>(hubHttpBase(opts.hub), path);
  const after = await api<TaskSpecView>(hubHttpBase(opts.hub), `${path}/retry`, { method: "POST", body: JSON.stringify(edit) });
  const corrected = JSON.stringify([before.spec.description, before.spec.acceptanceCriteria]) !== JSON.stringify([after.spec.description, after.spec.acceptanceCriteria]);
  console.log(`queued ${taskId} again${corrected ? ", with the task corrected" : ""}`);
}
