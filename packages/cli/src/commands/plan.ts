import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { resolveHubUrl } from "@aso/shared";

interface PlanView {
  planId: string;
  state: string;
  summary?: string;
  error?: string;
  tasks?: Array<{ key: string; role: string; kind: string; title: string; dependsOn: string[]; acceptanceCriteria: string[] }>;
  taskIds?: Record<string, string>;
  llm: { calls: number; costUsd: number };
  agentLog: Array<{ turn: number; actions: string[] }>;
}

function apiBase(hub: string): string {
  const url = resolveHubUrl(hub);
  return `${url.protocol === "wss:" ? "https" : "http"}://${url.host}`;
}

async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } });
  } catch {
    throw new Error(`cannot reach the Hub at ${base} (is it running? use --hub)`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Hub returned HTTP ${res.status}`);
  return body;
}

export async function planCommand(words: string[], opts: { hub: string; file?: string; yes: boolean }): Promise<void> {
  const requirement = opts.file ? await readFile(opts.file, "utf8") : words.join(" ");
  if (!requirement.trim()) throw new Error('give the requirement as text (aso plan "...") or with --file <path>');
  const base = apiBase(opts.hub);

  let plan = await api<PlanView>(base, "/api/plans", { method: "POST", body: JSON.stringify({ requirement }) });
  console.log(`${plan.planId}: waiting for the Architect...`);
  let shown = 0;
  const deadline = Date.now() + 30 * 60_000;
  while (plan.state === "pending" || plan.state === "planning") {
    if (Date.now() > deadline) throw new Error(`still ${plan.state} after 30 minutes; check the Architect (tmux attach -t aso-architect)`);
    await new Promise((r) => setTimeout(r, 2000));
    plan = await api<PlanView>(base, `/api/plans/${plan.planId}`);
    for (const t of plan.agentLog.slice(shown)) console.log(`  turn ${t.turn}: ${t.actions.join(", ")}`);
    shown = plan.agentLog.length;
  }

  if (plan.state !== "proposed") {
    throw new Error(`plan ${plan.state}${plan.error ? `: ${plan.error}` : ""}`);
  }
  printPlan(plan);

  let approve = opts.yes;
  if (!approve) {
    if (!process.stdin.isTTY) {
      console.log(`\nApprove with: aso plan-approve ${plan.planId}    Reject with: aso plan-reject ${plan.planId}`);
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nApprove and start these ${plan.tasks!.length} task(s)? [y/N] `);
    rl.close();
    approve = /^y(es)?$/i.test(answer.trim());
  }
  if (approve) await approvePlanCommand(plan.planId, opts);
  else await rejectPlanCommand(plan.planId, opts);
}

export async function approvePlanCommand(planId: string, opts: { hub: string }): Promise<void> {
  const plan = await api<PlanView>(apiBase(opts.hub), `/api/plans/${planId}/approve`, { method: "POST" });
  console.log(`approved ${plan.planId}; created tasks:`);
  for (const [key, id] of Object.entries(plan.taskIds ?? {})) console.log(`  ${key} -> ${id}`);
}

export async function rejectPlanCommand(planId: string, opts: { hub: string }): Promise<void> {
  await api<PlanView>(apiBase(opts.hub), `/api/plans/${planId}/reject`, { method: "POST" });
  console.log(`rejected ${planId}; no tasks were created`);
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
