import { CHALLENGER_ROLES, hubHttpBase, type ChallengerRole, type TuningView } from "@aso/shared";
import { api } from "../hub-api.js";
import { parseModelList } from "./models.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** What `aso pool` prints: each role's own model and members with their shares, then the latest changes. */
export function poolLines(v: TuningView, logLines = 10): string[] {
  const lines: string[] = [];
  for (const role of CHALLENGER_ROLES) {
    const r = v.roles[role];
    lines.push(`${role === "desks" ? "Desks" : "Reviewer"} (auto-tuning ${r.auto ? "on" : "off"}):`);
    lines.push(`  ${r.base ?? "no model"}: ${pct(r.baseShare)} (its own model)`);
    for (const m of r.members) {
      const state = m.ended ? `, ${m.ended}` : "";
      lines.push(`  ${m.model}: ${pct(m.share)}, ${m.samples} of ${m.needed} samples, $${m.spentUsd.toFixed(2)} of $${m.budgetUsd}${state}`);
    }
    if (r.candidates.length) lines.push(`  next to try: ${r.candidates.join(", ")}`);
  }
  const recent = v.log.slice(-logLines);
  if (recent.length) lines.push("", "Latest changes:", ...recent.map((e) => `  ${e.at.slice(0, 16).replace("T", " ")} ${e.role}: ${e.text}`));
  return lines;
}

function roleOf(role: string): ChallengerRole {
  const known = CHALLENGER_ROLES.find((r) => r === role);
  if (!known) throw new Error(`a pool is for the ${CHALLENGER_ROLES.join(" or the ")}, not "${role}"`);
  return known;
}

/** `aso pool`. */
export async function poolCommand(opts: { hub: string }): Promise<void> {
  console.log(poolLines(await api<TuningView>(hubHttpBase(opts.hub), "/api/tuning")).join("\n"));
}

/** `aso pool-auto <role> <on|off>`. */
export async function poolAutoCommand(role: string, state: string, opts: { hub: string }): Promise<void> {
  if (state !== "on" && state !== "off") throw new Error(`say on or off, not "${state}"`);
  const v = await api<TuningView>(hubHttpBase(opts.hub), "/api/tuning", { method: "POST", body: JSON.stringify({ role: roleOf(role), auto: state === "on" }) });
  console.log(poolLines(v, 3).join("\n"));
}

/** `aso pool-try <role> <models|none>`: the models auto-tuning tries next, in order. */
export async function poolTryCommand(role: string, models: string, opts: { hub: string }): Promise<void> {
  const candidates = models === "none" ? [] : parseModelList(models);
  const v = await api<TuningView>(hubHttpBase(opts.hub), "/api/tuning", { method: "POST", body: JSON.stringify({ role: roleOf(role), candidates }) });
  console.log(poolLines(v, 3).join("\n"));
}
