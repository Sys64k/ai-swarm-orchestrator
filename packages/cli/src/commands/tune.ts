import { hubHttpBase, SUGGESTION_ROLE_LABEL as ROLE, type ModelSuggestion, type ModelSuggestions } from "@aso/shared";
import { api } from "../hub-api.js";

export interface TuneOptions {
  hub: string;
  since?: string;
  json?: boolean;
}

/** The `aso desk` commands that apply a suggestion; none when no provider offers the model now. */
export function applyCommands(s: ModelSuggestion): string[] {
  return s.apply.map((a) => `aso desk ${a.target} ${a.model}`);
}

/** What `aso tune` prints: each suggestion with how to apply it, then why the other roles have none. */
export function tuneLines(r: ModelSuggestions): string[] {
  const lines = [`Model suggestions from jobs since ${r.since}:`];
  for (const s of r.suggestions) {
    const commands = applyCommands(s);
    lines.push(
      "",
      `${ROLE[s.role]}: ${s.suggested.model} instead of ${s.current.model} (${s.kind}).`,
      `  ${s.reason}`,
      ...(commands.length ? ["  To apply:", ...commands.map((c) => `    ${c}`)] : ["  No provider offers it now: add one (aso provider add) to apply this."]),
    );
  }
  if (!r.suggestions.length) lines.push("", "No suggestions.");
  if (r.notes.length) lines.push("", ...r.notes.map((n) => `${ROLE[n.role]}: ${n.text}`));
  return lines;
}

/** `aso tune`. */
export async function tuneCommand(opts: TuneOptions): Promise<void> {
  const path = `/api/model-suggestions${opts.since ? `?since=${encodeURIComponent(opts.since)}` : ""}`;
  const r = await api<ModelSuggestions>(hubHttpBase(opts.hub), path);
  console.log(opts.json ? JSON.stringify(r, null, 2) : tuneLines(r).join("\n"));
}
