import type Anthropic from "@anthropic-ai/sdk";
import type { LlmUsage, TaskDiff } from "@aso/shared";
import type { LlmAdapter } from "./adapter.js";
import { priceUsage } from "./pricing.js";

/** How much of the diff the reviewer reads; a larger diff is cut, and the verdict says so. */
export const ACCEPTANCE_DIFF_LIMIT = 120_000;

/** One criterion's verdict. `unclear`: the diff doesn't show whether it is met (it doesn't block). */
export interface CriterionVerdict {
  criterion: string;
  verdict: "met" | "unmet" | "unclear";
  reason: string;
}

export type AcceptanceVerdict =
  | { result: "met" | "unmet"; criteria: CriterionVerdict[]; summary: string; model: string; usage: LlmUsage }
  /** The check couldn't decide (no model, a model error, an answer it couldn't read): the work goes on. */
  | { result: "undecided"; reason: string; model?: string; usage?: LlmUsage };

/** What the check reads of a task. */
export interface AcceptanceSubject {
  spec: { title: string; description: string; acceptanceCriteria: string[] };
  summary?: string;
}

const TOOL: Anthropic.Beta.BetaTool = {
  name: "report_acceptance",
  description: "Report, for every acceptance criterion in order, whether the change meets it.",
  input_schema: {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        description: "One entry per acceptance criterion, in the order given.",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The criterion's number, from 1" },
            verdict: { type: "string", enum: ["met", "unmet", "unclear"], description: "unclear: the diff doesn't show it either way" },
            reason: { type: "string", description: "One sentence: what in the diff shows it, or what is missing" },
          },
          required: ["index", "verdict", "reason"],
        },
      },
      summary: { type: "string", description: "One or two sentences for the reviewer" },
    },
    required: ["criteria", "summary"],
  },
};

const SYSTEM = `You check whether a code change does what its task asked, before a person reviews it.
Judge each acceptance criterion against the diff only: what the change adds, removes or modifies.
- met: the diff clearly does it.
- unmet: the diff doesn't do it, or does something else instead. Say what is missing.
- unclear: the diff can't show it either way (for example, it depends on code outside the diff, or the diff is cut).
The tests already passed, so don't re-check that the code runs; check that it does what was asked.
Don't judge style or suggest improvements. Answer only by calling report_acceptance.`;

/** The diff as the reviewer reads it, cut to `limit` characters. */
export function diffText(diff: TaskDiff, limit = ACCEPTANCE_DIFF_LIMIT): { text: string; cut: boolean } {
  let text = "";
  let cut = diff.truncated;
  for (const f of diff.files) {
    const part = `--- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n${f.patch ?? "(patch left out)"}\n`;
    if (text.length + part.length > limit) {
      cut = true;
      text += `--- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}): left out, the diff is too large\n`;
      continue;
    }
    text += part;
  }
  return { text, cut };
}

export function acceptancePrompt(task: AcceptanceSubject, diff: TaskDiff): string {
  const { text, cut } = diffText(diff);
  return [
    `Task: ${task.spec.title}`,
    "",
    task.spec.description.trim(),
    "",
    "Acceptance criteria:",
    ...task.spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    ...(task.summary?.trim() ? ["", "The agent's own summary (a claim, not proof):", task.summary.trim()] : []),
    "",
    cut ? "The diff (cut: parts are left out, so mark what you can't see as unclear):" : "The diff:",
    text,
  ].join("\n");
}

/** The verdict from the model's answer, or a reason it can't be read. */
export function readVerdict(content: Anthropic.Beta.BetaContentBlock[], criteria: string[]): { criteria: CriterionVerdict[]; summary: string } | { error: string } {
  const call = content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === TOOL.name);
  if (!call) return { error: "the model didn't report a verdict" };
  const input = call.input as { criteria?: unknown; summary?: unknown };
  if (!Array.isArray(input.criteria)) return { error: "the verdict has no criteria" };
  const byIndex = new Map<number, { verdict: CriterionVerdict["verdict"]; reason: string }>();
  for (const entry of input.criteria as Array<{ index?: unknown; verdict?: unknown; reason?: unknown }>) {
    if (typeof entry.index !== "number" || !["met", "unmet", "unclear"].includes(entry.verdict as string)) continue;
    byIndex.set(entry.index, { verdict: entry.verdict as CriterionVerdict["verdict"], reason: typeof entry.reason === "string" ? entry.reason.trim() : "" });
  }
  const verdicts: CriterionVerdict[] = [];
  for (const [i, criterion] of criteria.entries()) {
    const found = byIndex.get(i + 1);
    if (!found) return { error: `the verdict skips criterion ${i + 1}` };
    verdicts.push({ criterion, ...found });
  }
  return { criteria: verdicts, summary: typeof input.summary === "string" ? input.summary.trim() : "" };
}

/**
 * Checks finished work against its task's acceptance criteria with a strong model, after the
 * tests passed: tests show the code runs, not that it does what was asked (a cheaper builder
 * model may hand in something else). `model` resolves once the Hub has its models; undefined
 * means none, and every check is undecided.
 */
export class AcceptanceChecker {
  constructor(private readonly model: Promise<LlmAdapter | undefined>) {}

  async check(task: AcceptanceSubject, diff: TaskDiff | undefined): Promise<AcceptanceVerdict> {
    const adapter = await this.model;
    if (!adapter) return { result: "undecided", reason: "no model is configured for the check" };
    if (!diff || diff.files.length === 0) return { result: "undecided", reason: "there is no diff to check" };
    let response;
    try {
      response = await adapter.complete({ system: SYSTEM, tools: [TOOL], messages: [{ role: "user", content: acceptancePrompt(task, diff) }] });
    } catch (err) {
      return { result: "undecided", reason: `the model failed: ${(err as Error).message}`, model: adapter.model };
    }
    const usage = priceUsage(response.model, response.tokens);
    const read = readVerdict(response.content, task.spec.acceptanceCriteria);
    if ("error" in read) return { result: "undecided", reason: read.error, model: response.model, usage };
    const unmet = read.criteria.some((c) => c.verdict === "unmet");
    return { result: unmet ? "unmet" : "met", ...read, model: response.model, usage };
  }
}

/** What goes back to the agent when criteria are unmet. */
export function unmetReason(criteria: CriterionVerdict[]): string {
  const unmet = criteria.filter((c) => c.verdict === "unmet");
  return [
    `Acceptance check: ${unmet.length} of ${criteria.length} criteria not met.`,
    ...unmet.map((c) => `- ${c.criterion}\n  Missing: ${c.reason || "(no reason given)"}`),
    "Do these before finishing; the tests passing isn't enough.",
  ].join("\n");
}

/** "2 of 3 criteria met, 1 unclear": the same counts in the task's history and its pull request. */
export function acceptanceCounts(criteria: CriterionVerdict[]): string {
  const n = (v: CriterionVerdict["verdict"]) => criteria.filter((c) => c.verdict === v).length;
  const extra = [n("unmet") && `${n("unmet")} unmet`, n("unclear") && `${n("unclear")} unclear`].filter(Boolean);
  return `${n("met")} of ${criteria.length} criteria met${extra.length ? `, ${extra.join(", ")}` : ""}`;
}
