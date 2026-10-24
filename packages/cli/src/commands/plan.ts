import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { hubHttpBase, type PlanDialogueEntry } from "@aso/shared";
import { api } from "../hub-api.js";

interface PlanView {
  planId: string;
  project: string;
  state: string;
  summary?: string;
  error?: string;
  tasks?: Array<{ key: string; role: string; kind: string; title: string; dependsOn: string[]; acceptanceCriteria: string[] }>;
  taskIds?: Record<string, string>;
  questions?: string[];
  dialogue?: PlanDialogueEntry[];
  llm: { calls: number; costUsd: number };
  agentLog: Array<{ turn: number; actions: string[] }>;
}

export async function planCommand(words: string[], opts: { hub: string; file?: string; yes: boolean; project?: string }): Promise<void> {
  const requirement = opts.file ? await readFile(opts.file, "utf8") : words.join(" ");
  if (!requirement.trim()) throw new Error('give the requirement as text (aso plan "...") or with --file <path>');
  const base = hubHttpBase(opts.hub);

  let plan = await api<PlanView>(base, "/api/plans", { method: "POST", body: JSON.stringify({ requirement, project: opts.project }) });
  console.log(`${plan.planId} (${plan.project}): waiting for the Architect...`);
  const interactive = process.stdin.isTTY && !opts.yes;
  const shown = { turns: 0 };
  // Each reply (answers, or changes to a proposal) is another planning round.
  for (;;) {
    plan = await waitForArchitect(base, plan, shown);
    if (plan.state === "awaiting_input") {
      printQuestions(plan);
      if (!interactive) {
        console.log(`\nAnswer with: aso plan-reply ${plan.planId} "..."    (or in the console)    Reject with: aso plan-reject ${plan.planId}`);
        return;
      }
      const answer = await ask("\nYour answers (empty line rejects the plan): ");
      if (!answer) return rejectPlanCommand(plan.planId, opts);
      plan = await reply(base, plan.planId, answer);
      continue;
    }
    if (plan.state !== "proposed") throw new Error(`plan ${plan.state}${plan.error ? `: ${plan.error}` : ""}`);
    printPlan(plan);
    if (opts.yes) return approvePlanCommand(plan.planId, opts);
    if (!interactive) {
      console.log(`\nApprove with: aso plan-approve ${plan.planId}    Ask for changes: aso plan-reply ${plan.planId} "..."    Reject with: aso plan-reject ${plan.planId}`);
      return;
    }
    const answer = await ask(`\nApprove and start these ${plan.tasks!.length} task(s)? [y/N, or type what to change] `);
    const decision = approvalAnswer(answer);
    if (decision === "approve") return approvePlanCommand(plan.planId, opts);
    if (decision === "reject") return rejectPlanCommand(plan.planId, opts);
    plan = await reply(base, plan.planId, answer.trim());
  }
}

/** What the person typed at the approval prompt: y/yes approves, n/no/empty rejects, anything else asks for changes. */
export function approvalAnswer(answer: string): "approve" | "reject" | "changes" {
  const a = answer.trim();
  if (/^y(es)?$/i.test(a)) return "approve";
  if (!a || /^no?$/i.test(a)) return "reject";
  return "changes";
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

async function reply(base: string, planId: string, message: string): Promise<PlanView> {
  const plan = await api<PlanView>(base, `/api/plans/${planId}/reply`, { method: "POST", body: JSON.stringify({ message }) });
  console.log(`${planId}: sent; the Architect is planning again...`);
  return plan;
}

/** Poll until the Architect has answered (proposed, questions, failed...), printing its turns. */
async function waitForArchitect(base: string, plan: PlanView, shown: { turns: number }): Promise<PlanView> {
  const deadline = Date.now() + 30 * 60_000;
  while (plan.state === "pending" || plan.state === "planning") {
    if (Date.now() > deadline) throw new Error(`still ${plan.state} after 30 minutes; check the Architect (tmux attach -t aso-architect)`);
    await new Promise((r) => setTimeout(r, 2000));
    plan = await api<PlanView>(base, `/api/plans/${plan.planId}`);
    for (const t of plan.agentLog.slice(shown.turns)) console.log(`  turn ${t.turn}: ${t.actions.join(", ")}`);
    shown.turns = plan.agentLog.length;
  }
  return plan;
}

export async function replyPlanCommand(planId: string, words: string[], opts: { hub: string }): Promise<void> {
  const message = words.join(" ").trim();
  if (!message) throw new Error('give your answer or the changes you want as text: aso plan-reply <planId> "..."');
  await reply(hubHttpBase(opts.hub), planId, message);
  console.log(`follow it in the console, or: aso plan-approve ${planId} once it is proposed again`);
}

export async function approvePlanCommand(planId: string, opts: { hub: string }): Promise<void> {
  const plan = await api<PlanView>(hubHttpBase(opts.hub), `/api/plans/${planId}/approve`, { method: "POST" });
  console.log(`approved ${plan.planId}; created tasks:`);
  for (const [key, id] of Object.entries(plan.taskIds ?? {})) console.log(`  ${key} -> ${id}`);
}

export async function rejectPlanCommand(planId: string, opts: { hub: string }): Promise<void> {
  await api<PlanView>(hubHttpBase(opts.hub), `/api/plans/${planId}/reject`, { method: "POST" });
  console.log(`rejected ${planId}; no tasks were created`);
}

function printQuestions(plan: PlanView): void {
  const last = plan.dialogue?.at(-1);
  const context = last?.kind === "questions" ? last.context : undefined;
  console.log(`\nThe Architect has questions${context ? ` (${context})` : ""}:`);
  for (const [i, q] of (plan.questions ?? []).entries()) console.log(`  ${i + 1}. ${q}`);
}

function printPlan(plan: PlanView): void {
  console.log(`\n${plan.summary}\n`);
  for (const [i, t] of plan.tasks!.entries()) {
    const deps = t.dependsOn.length ? `  (after ${t.dependsOn.join(", ")})` : "";
    console.log(`${i + 1}. [${t.role}/${t.kind}] ${t.key}: ${t.title}${deps}`);
    for (const c of t.acceptanceCriteria) console.log(`     - ${c}`);
  }
  console.log(`\nPlanning cost: ${plan.llm.calls} model turns, ~$${plan.llm.costUsd.toFixed(3)}`);
}
