import { hubHttpBase, type Models } from "@aso/shared";
import { api } from "../hub-api.js";

/** The lines `aso models` prints: the Architect, the default, each profile with its desks, then the desks. */
export function modelLines(m: Models): string[] {
  const lines = [`Architect: ${m.architect ?? "none"}`, `Desks without a profile: ${m.defaultAgent ?? "none"}`];
  if (m.profiles.length === 0) return [...lines, "", "No model profiles: `aso model-profile set <name> <model>` adds one."];
  lines.push("", "Profiles:");
  for (const p of m.profiles) {
    const where = p.baseUrl ? ` at ${p.baseUrl}` : "";
    const busy = p.running || p.waiting ? ` (${p.running} running, ${p.waiting} waiting)` : "";
    lines.push(`  ${p.name}: ${p.model}${where}, ${p.concurrency} at once${p.vision ? ", sees images" : ""}${busy}`);
  }
  lines.push("", m.desks.length ? "Desks:" : "No desk uses a profile yet: `aso desk <host>#<slot> <profile>`.");
  for (const d of m.desks) lines.push(`  ${d.desk}: ${d.profile}`);
  return lines;
}

const printModels = (m: Models) => console.log(modelLines(m).join("\n"));

/** `aso models`. */
export async function modelsCommand(opts: { hub: string }): Promise<void> {
  printModels(await api<Models>(hubHttpBase(opts.hub), "/api/models"));
}

/** `aso model-profile set <name> <model>`. */
export async function setModelProfileCommand(
  name: string,
  model: string,
  opts: { hub: string; baseUrl?: string; concurrency?: number; vision?: boolean },
): Promise<void> {
  const body = {
    model,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.vision !== undefined ? { vision: opts.vision } : {}),
  };
  printModels(await api<Models>(hubHttpBase(opts.hub), `/api/models/profiles/${encodeURIComponent(name)}`, { method: "POST", body: JSON.stringify(body) }));
}

/** `aso model-profile remove <name>`. */
export async function removeModelProfileCommand(name: string, opts: { hub: string }): Promise<void> {
  printModels(await api<Models>(hubHttpBase(opts.hub), `/api/models/profiles/${encodeURIComponent(name)}/remove`, { method: "POST" }));
}

/** `aso desk <host>#<slot> <profile|default>`. */
export async function deskCommand(desk: string, profile: string, opts: { hub: string }): Promise<void> {
  const body = { desk, profile: profile === "default" ? null : profile };
  printModels(await api<Models>(hubHttpBase(opts.hub), "/api/models/desks", { method: "POST", body: JSON.stringify(body) }));
}
