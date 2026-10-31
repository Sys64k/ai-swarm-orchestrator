import { DIAGNOSIS_ACTION_LABEL, DIAGNOSIS_ACTIONS, DIAGNOSIS_CAUSE_LABEL, DIAGNOSIS_CAUSES, hubHttpBase, type ProductOwnerRecord } from "@aso/shared";
import { api } from "../hub-api.js";

export interface ProductOwnerOptions {
  hub: string;
  project?: string;
  since?: string;
}

/** What `aso product-owner` prints: what it read, what people did with its proposals, whether its retries worked. */
export function productOwnerText(r: ProductOwnerRecord): string {
  if (r.diagnosed === 0) return r.couldNot ? `the product owner couldn't read ${r.couldNot} failure(s) and has read none` : "the product owner hasn't read any failures yet";
  const d = r.decisions;
  const t = r.retries;
  const lines = [
    `read:       ${r.diagnosed} failures${r.couldNot ? ` (couldn't read ${r.couldNot})` : ""}, $${r.costUsd.toFixed(2)}`,
    `answered:   ${d.accepted} accepted, ${d.refused} refused, ${d.waiting} waiting for you, ${d.unanswered} never answered`,
    `retries:    ${t.accepted} accepted: ${t.merged} merged, ${t.failedAgain} failed again, ${t.underway} still going`,
    `quotes:     ${r.quotes.notFound} of ${r.quotes.total} not found in their source`,
    "",
    "causes:",
    ...DIAGNOSIS_CAUSES.filter((c) => r.causes[c] > 0).map((c) => `  ${r.causes[c]}  ${DIAGNOSIS_CAUSE_LABEL[c]}`),
    "proposals (accepted / refused):",
    ...DIAGNOSIS_ACTIONS.filter((a) => r.actions[a].proposed > 0).map((a) => `  ${r.actions[a].proposed}  ${DIAGNOSIS_ACTION_LABEL[a]} (${r.actions[a].accepted} / ${r.actions[a].refused})`),
  ];
  return lines.join("\n");
}

export async function productOwnerCommand(opts: ProductOwnerOptions): Promise<void> {
  const q = new URLSearchParams();
  if (opts.project) q.set("project", opts.project);
  if (opts.since) q.set("since", opts.since);
  const query = q.toString();
  console.log(productOwnerText(await api<ProductOwnerRecord>(hubHttpBase(opts.hub), `/api/product-owner${query ? `?${query}` : ""}`)));
}
