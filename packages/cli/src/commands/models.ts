import { hubHttpBase, type Desks, type Models } from "@aso/shared";
import { api } from "../hub-api.js";

/** What `aso models` prints: the models to choose from. */
export function modelLines(m: Models): string[] {
  const lines = [`Architect: ${m.architect ?? "none"}`, `Desks without a model of their own: ${m.defaultAgent ?? "none"}`, ""];
  const claude = m.available.filter((a) => a.provider === "anthropic");
  const local = m.available.filter((a) => a.provider === "openai-compatible");
  lines.push(claude.length ? "Claude:" : "Claude: none (the Hub has no ANTHROPIC_API_KEY)");
  for (const a of claude) lines.push(`  ${a.model}`);
  if (local.length) lines.push(`Local (${local[0].baseUrl}):`);
  for (const a of local) lines.push(`  ${a.model}`);
  if (m.localError) lines.push(`Local models: ${m.localError}`);
  else if (!local.length) lines.push("Local: none (set ASO_LLM_BASE_URL on the Hub, e.g. to Ollama's http://<host>:11434/v1)");
  lines.push("", "Put a desk on one with `aso desk <host>#<slot> <model>`, or a whole machine with `aso desk <host> <model>`.");
  return lines;
}

/** What `aso desks` and `aso desk` print: each desk with its own model, and each model's load. */
export function deskLines(d: Desks): string[] {
  const lines = [`Desks without a model of their own: ${d.defaultAgent ?? "none"}`];
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

/** `aso desks`. */
export async function desksCommand(opts: { hub: string }): Promise<void> {
  console.log(deskLines(await api<Desks>(hubHttpBase(opts.hub), "/api/desks")).join("\n"));
}

/** `aso desk <host>[#<slot>] <model|default>`. */
export async function deskCommand(
  target: string,
  model: string,
  opts: { hub: string; concurrency?: number; baseUrl?: string; vision?: boolean },
): Promise<void> {
  const body = {
    target,
    model,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.vision !== undefined ? { vision: opts.vision } : {}),
  };
  const desks = await api<Desks>(hubHttpBase(opts.hub), "/api/desks", { method: "POST", body: JSON.stringify(body) });
  console.log(deskLines(desks).join("\n"));
}
