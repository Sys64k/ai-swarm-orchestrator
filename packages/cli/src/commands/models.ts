import { hubHttpBase, MODEL_ROLES, type ApiNode, type Desks, type Models } from "@aso/shared";
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
  const lines = [`Architect: ${d.architect ?? "none"}`, `Reviewer (acceptance check): ${reviewer}`, `Desks without a model of their own: ${d.defaultAgent ?? "none"}`];
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
