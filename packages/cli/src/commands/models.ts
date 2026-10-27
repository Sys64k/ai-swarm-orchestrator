import { CHALLENGER_ROLES, hubHttpBase, MODEL_ROLES, type ApiNode, type ChallengerRole, type Desks, type Models, type Trial } from "@aso/shared";
import { api } from "../hub-api.js";

/** What `aso models` prints: the models to choose from. */
export function modelLines(m: Models): string[] {
  const lines = [`Architect: ${m.architect ?? "none"}`, `Desks without a model of their own: ${m.defaultAgent ?? "none"}`, ""];
  if (!m.available.length) lines.push("No models: add a provider with `aso provider add` (see `aso providers`).");
  // One heading per provider, in the Hub's order; each model by the spec desks are put on.
  const groups = new Map<string, string[]>();
  for (const a of m.available) {
    const heading = a.providerLabel ? `${a.providerLabel} (${a.providerId ?? a.provider})` : (a.providerId ?? a.provider);
    groups.set(heading, [...(groups.get(heading) ?? []), a.spec]);
  }
  for (const [heading, specs] of groups) lines.push(`${heading}:`, ...specs.map((s) => `  ${s}`));
  if (m.localError) lines.push("", `Couldn't list: ${m.localError}`);
  lines.push("", "Put a desk on one with `aso desk <host>#<slot> <provider>/<model>`, or a whole machine with `aso desk <host> <provider>/<model>`.");
  return lines;
}

/** What `aso desks` and `aso desk` print: each desk with its own model, and each model's load. */
export function deskLines(d: Desks): string[] {
  // An older Hub sends no reviewer: its acceptance check uses the Architect's model.
  const reviewerModel = d.reviewer ?? d.architect;
  const reviewer = reviewerModel && reviewerModel === d.architect ? `${reviewerModel} (the Architect's)` : (reviewerModel ?? "none");
  const lines = [`Architect: ${d.architect ?? "none"}`, `Reviewer (acceptance check): ${reviewer}`, ...escalationLines(d), ...trialLines(d), `Desks without a model of their own: ${d.defaultAgent ?? "none"}`];
  if (!d.desks.length) return [...lines, "Every desk uses it. `aso desk <host>#<slot> <model>` changes one."];
  lines.push("");
  for (const { desk, model } of d.desks) lines.push(`  ${desk}: ${model}`);
  lines.push("");
  for (const m of d.models) {
    const busy = m.running || m.waiting ? `, ${m.running} running, ${m.waiting} waiting` : "";
    lines.push(`${m.model}${m.baseUrl ? ` at ${m.baseUrl}` : ""}: ${m.concurrency} call${m.concurrency === 1 ? "" : "s"} at once${busy}`);
  }
  return lines;
}

/** Where failing tasks move, as `aso desks` and `aso escalation` show it; nothing for an older Hub that doesn't say. */
export function escalationLines(d: Pick<Desks, "escalation" | "escalationSet">): string[] {
  if (d.escalation === undefined) return [];
  if (d.escalation === null) return ["Escalation: off (every round on the desk's model)"];
  const { ladder, juniorTries } = d.escalation;
  const set = d.escalationSet ?? {};
  const changed = set.ladder !== undefined || set.juniorTries !== undefined ? " (changed with `aso escalation`)" : "";
  return [`Escalation: after ${juniorTries} ${juniorTries === 1 ? "try" : "tries"} on a desk's model, to ${ladder.join(", then ")}${changed}`];
}

/** A trial in a line: "On trial for the desks: openai/gpt-6.1-terra, 10% of the work, 3 of 10 settled tasks, $0.80 of $5". */
export function trialLine(role: ChallengerRole, t: Trial): string {
  const unit = role === "desks" ? "settled tasks" : "met verdicts";
  const state = t.ended ? ` (ended: ${t.ended})` : "";
  return `On trial for the ${role}: ${t.model}, ${Math.round(t.share * 100)}% of the work, ${t.samples} of ${t.needed} ${unit}, $${t.spentUsd.toFixed(2)} of $${t.budgetUsd}${state}`;
}

/** Each trial, as `aso desks` shows them; nothing for an older Hub or without trials. */
export function trialLines(d: Pick<Desks, "challengers">): string[] {
  return CHALLENGER_ROLES.flatMap((role) => {
    const t = d.challengers?.[role];
    return t ? [trialLine(role, t)] : [];
  });
}

/** `aso challenger <desks|reviewer> <model|none>`: put a model on trial for a share of the work, or end the trial. */
export async function challengerCommand(role: string, model: string, opts: { hub: string; share?: number; budget?: number }): Promise<void> {
  const known = CHALLENGER_ROLES.find((r) => r === role);
  if (!known) throw new Error(`a trial is for the ${CHALLENGER_ROLES.join(" or the ")}, not "${role}"`);
  const body = { role: known, model, ...(opts.share !== undefined ? { share: opts.share / 100 } : {}), ...(opts.budget !== undefined ? { budgetUsd: opts.budget } : {}) };
  const desks = await api<Desks>(hubHttpBase(opts.hub), "/api/models/challengers", { method: "POST", body: JSON.stringify(body) });
  const t = desks.challengers?.[known];
  console.log(t ? trialLine(known, t) : `No model on trial for the ${known}.`);
}

/** `aso escalation [models]`: show where failing tasks move, or change the ladder and the tries before it. */
export async function escalationCommand(models: string | undefined, opts: { hub: string; juniorTries?: number | "default" }): Promise<void> {
  const base = hubHttpBase(opts.hub);
  if (models === undefined && opts.juniorTries === undefined) {
    console.log(escalationLines(await api<Desks>(base, "/api/desks")).join("\n") || "This Hub doesn't say; update it.");
    return;
  }
  const body = {
    ...(models !== undefined ? { ladder: models === "default" ? "default" : models.split(",").map((m) => m.trim()).filter(Boolean) } : {}),
    ...(opts.juniorTries !== undefined ? { juniorTries: opts.juniorTries } : {}),
  };
  const desks = await api<Desks>(base, "/api/models/escalation", { method: "POST", body: JSON.stringify(body) });
  console.log(escalationLines(desks).join("\n"));
}

/** `aso models`. */
export async function modelsCommand(opts: { hub: string }): Promise<void> {
  console.log(modelLines(await api<Models>(hubHttpBase(opts.hub), "/api/models")).join("\n"));
}

/** Machines that serve their own models: "avalon serves its own: qwen3-coder:30b (its desks use it)". */
export function ownModelLines(nodes: ReadonlyArray<Pick<ApiNode, "hardware" | "localModels" | "defaultLocalModel">>): string[] {
  const lines = nodes.flatMap((n) => {
    if (!n.localModels?.length || !n.hardware) return [];
    const used = n.defaultLocalModel ?? n.localModels[0].id;
    return [`  ${n.hardware.hostname} serves its own: ${n.localModels.map((m) => m.id).join(", ")} (its desks use ${used}, free, unless put on another model)`];
  });
  return lines.length ? ["", "Machines' own models (machine/<model>):", ...lines] : [];
}

/** `aso desks`. */
export async function desksCommand(opts: { hub: string }): Promise<void> {
  const base = hubHttpBase(opts.hub);
  const [desks, nodes] = await Promise.all([api<Desks>(base, "/api/desks"), api<ApiNode[]>(base, "/api/nodes")]);
  console.log([...deskLines(desks), ...ownModelLines(nodes)].join("\n"));
}

/** `aso desk <host>[#<slot>] <model|default>`, or `aso desk architect|reviewer <model|default>`. */
export async function deskCommand(
  target: string,
  model: string,
  opts: { hub: string; concurrency?: number; baseUrl?: string; vision?: boolean },
): Promise<void> {
  const settings = {
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.vision !== undefined ? { vision: opts.vision } : {}),
  };
  const role = MODEL_ROLES.find((r) => r === target);
  const [route, body] = role ? ["/api/models/roles", { role, model, ...settings }] : ["/api/desks", { target, model, ...settings }];
  const desks = await api<Desks>(hubHttpBase(opts.hub), route, { method: "POST", body: JSON.stringify(body) });
  console.log(deskLines(desks).join("\n"));
}
