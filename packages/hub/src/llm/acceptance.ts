import type Anthropic from "@anthropic-ai/sdk";
import { createLogger, isBlockingNote, MAX_QUALITY_NOTES, QUALITY_NOTE_KINDS, type LlmUsage, type QualityNote, type QualityNoteKind, type TaskDiff } from "@aso/shared";
import type { LlmAdapter } from "./adapter.js";
import { priceUsage } from "./pricing.js";

const log = createLogger("acceptance");

/** Longest quality note and file name kept from a verdict. */
const MAX_NOTE_CHARS = 500;
const MAX_FILE_CHARS = 300;

/** How much of the diff the reviewer reads; a larger diff is cut, and the verdict says so. */
export const ACCEPTANCE_DIFF_LIMIT = 120_000;

/** One criterion's verdict. `unclear`: the diff doesn't show whether it is met (it doesn't block). */
export interface CriterionVerdict {
  criterion: string;
  verdict: "met" | "unmet" | "unclear";
  reason: string;
}

export type AcceptanceVerdict =
  | { result: "met" | "unmet"; criteria: CriterionVerdict[]; summary: string; qualityNotes?: QualityNote[]; model: string; usage: LlmUsage }
  /** The check couldn't decide (no model, a model error, an answer it couldn't read): the work goes on. */
  | { result: "undecided"; reason: string; model?: string; usage?: LlmUsage };

/** What the check reads of a task. */
export interface AcceptanceSubject {
  spec: { taskId?: string; title: string; description: string; acceptanceCriteria: string[] };
  summary?: string;
  /** The commit being judged. */
  commit?: string;
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
      quality_notes: {
        type: "array",
        description: `Concrete quality problems in the diff besides the criteria, at most ${MAX_QUALITY_NOTES}; none is fine. Only tests-weakened sends the work back.`,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...QUALITY_NOTE_KINDS] },
            note: { type: "string", description: "One sentence: what and where" },
            file: { type: "string", description: "The file, when it is one" },
          },
          required: ["kind", "note"],
        },
      },
    },
    required: ["criteria", "summary"],
  },
};

const SYSTEM = `You check whether a code change does what its task asked, before a person reviews it.
Judge each acceptance criterion against the diff only: what the change adds, removes or modifies.
- met: the diff clearly does it.
- unmet: the diff doesn't do it, or does something else instead. Say what is missing.
- unclear: the diff can't show it either way (for example, it depends on code outside the diff, or the diff is cut).
A criterion that asks for tests, or for a file to be added or changed, is unmet when the diff has no such change: the diff does show that.
The tests already passed, so don't re-check that the code runs; check that it does what was asked.
Then note quality problems the diff shows: duplication (logic copied where existing code could be reused), dead-code
(unused or unreachable code added), misleading-summary (the agent's summary claims what the diff doesn't do), other (a
concrete defect risk). These don't block the work. Only concrete problems you can point at; not style preferences or
suggestions.
One note does send the work back: tests-weakened, when the diff changes an existing test so that it checks less or
expects something else: deleted or skipped, an assertion removed or loosened, an expected value changed. Not when the
task's description or criteria ask for that behaviour to change (then the test should change), and not for a test
renamed or moved that still checks the same. Name the test and what changed. Answer only by calling report_acceptance.`;

/** A test file by its path: *.test.* or *.spec.*, or anything under a test, tests or __tests__ folder. */
export function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[^/]+$/.test(path) || /(^|\/)(tests?|__tests__)\//.test(path);
}

/** The test files that were already there and the change modifies or deletes: where weakened tests hide. */
export function changedTestFiles(diff: TaskDiff): string[] {
  return diff.files.filter((f) => f.status !== "added" && isTestFile(f.path)).map((f) => `${f.path} (${f.status})`);
}

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
  const tests = changedTestFiles(diff);
  return [
    `Task: ${task.spec.title}`,
    "",
    task.spec.description.trim(),
    "",
    "Acceptance criteria:",
    ...task.spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    ...(task.summary?.trim() ? ["", "The agent's own summary (a claim, not proof):", task.summary.trim()] : []),
    ...(tests.length ? ["", "Existing test files this change modifies or deletes (check them for weakened tests):", ...tests.map((t) => `- ${t}`)] : []),
    "",
    cut ? "The diff (cut: parts are left out, so mark what you can't see as unclear):" : "The diff:",
    text,
  ].join("\n");
}

/** The verdict from the model's answer, or a reason it can't be read. */
export function readVerdict(
  content: Anthropic.Beta.BetaContentBlock[],
  criteria: string[],
): { criteria: CriterionVerdict[]; summary: string; qualityNotes: QualityNote[] } | { error: string } {
  const call = content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === TOOL.name);
  if (!call) return { error: "the model didn't report a verdict" };
  const input = call.input as { criteria?: unknown; summary?: unknown; quality_notes?: unknown };
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
  return { criteria: verdicts, summary: typeof input.summary === "string" ? input.summary.trim() : "", qualityNotes: readQualityNotes(input.quality_notes) };
}

const isQualityNoteKind = (kind: unknown): kind is QualityNoteKind => QUALITY_NOTE_KINDS.includes(kind as QualityNoteKind);

/** The verdict's quality notes, dropping any it can't read, at most MAX_QUALITY_NOTES. */
function readQualityNotes(raw: unknown): QualityNote[] {
  if (!Array.isArray(raw)) return [];
  const notes: QualityNote[] = [];
  for (const entry of raw as Array<{ kind?: unknown; note?: unknown; file?: unknown }>) {
    const note = typeof entry.note === "string" ? entry.note.trim().slice(0, MAX_NOTE_CHARS) : "";
    if (!note || !isQualityNoteKind(entry.kind)) continue;
    const file = typeof entry.file === "string" && entry.file.trim() ? entry.file.trim().slice(0, MAX_FILE_CHARS) : undefined;
    notes.push({ kind: entry.kind, note, ...(file ? { file } : {}) });
  }
  return notes.slice(0, MAX_QUALITY_NOTES);
}

/**
 * Checks finished work against its task's acceptance criteria with a strong model, after the
 * tests passed: tests show the code runs, not that it does what was asked (a cheaper builder
 * model may hand in something else). `models` resolves once the Hub has its models; none means
 * every check is undecided.
 */
export class AcceptanceChecker {
  /**
   * `models`: asked at each check, for that task (the reviewer's can change while the Hub runs, and a
   * model on trial may take this one), in order: the reviewer's, then the Hub's own. A model whose call fails (refused, down) hands the check to
   * the next, so a reviewer that can't do the job doesn't leave every task undecided.
   */
  constructor(private readonly models: (task: AcceptanceSubject) => Promise<ReadonlyArray<LlmAdapter | undefined>>) {}

  async check(task: AcceptanceSubject, diff: TaskDiff | undefined): Promise<AcceptanceVerdict> {
    const adapters = (await this.models(task)).filter((a, i, all): a is LlmAdapter => a !== undefined && all.findIndex((b) => b?.model === a.model) === i);
    if (!adapters.length) return { result: "undecided", reason: "no model is configured for the check" };
    if (!diff || diff.files.length === 0) return { result: "undecided", reason: "there is no diff to check" };
    let response;
    let adapter = adapters[0];
    const failures: string[] = [];
    for (const next of adapters) {
      adapter = next;
      try {
        response = await adapter.complete({ system: SYSTEM, tools: [TOOL], messages: [{ role: "user", content: acceptancePrompt(task, diff) }] });
        break;
      } catch (err) {
        failures.push(`${adapter.model}: ${(err as Error).message}`);
        if (next !== adapters.at(-1)) log.warn(`"${task.spec.title}": the acceptance check failed on ${adapter.model} (${(err as Error).message}); trying ${adapters[adapters.indexOf(next) + 1].model}`);
      }
    }
    if (!response) {
      const reason = failures.length === 1 ? `the model failed: ${failures[0].slice(adapter.model.length + 2)}` : `every model failed: ${failures.join("; ")}`;
      return { result: "undecided", reason, model: adapter.model };
    }
    const usage = priceUsage(response.model, response.tokens);
    const read = readVerdict(response.content, task.spec.acceptanceCriteria);
    // The model by the name the Hub calls it, as builds record theirs, so track records line up.
    if ("error" in read) return { result: "undecided", reason: read.error, model: adapter.model, usage };
    const unmet = read.criteria.some((c) => c.verdict === "unmet") || read.qualityNotes.some(isBlockingNote);
    return { result: unmet ? "unmet" : "met", ...read, model: adapter.model, usage };
  }
}

/** What goes back to the agent when criteria are unmet or existing tests were weakened. */
export function unmetReason(criteria: CriterionVerdict[], notes: readonly QualityNote[] = []): string {
  const unmet = criteria.filter((c) => c.verdict === "unmet");
  const weakened = notes.filter(isBlockingNote);
  const problems = [unmet.length && `${unmet.length} of ${criteria.length} criteria not met`, weakened.length && "existing tests weakened"].filter(Boolean);
  return [
    `Acceptance check: ${problems.join("; ")}.`,
    ...unmet.map((c) => `- ${c.criterion}\n  Missing: ${c.reason || "(no reason given)"}`),
    ...weakened.map((n) => `- Existing tests weakened${n.file ? ` (${n.file})` : ""}: ${n.note}`),
    ...(weakened.length ? ["Put those tests back as they were and change the code to pass them, not the tests to pass the code."] : []),
    "Do these before finishing; the tests passing isn't enough.",
  ].join("\n");
}

/** "; 2 quality notes" (", 1 blocking" when one sent the work back) for the task's history, or nothing without notes. */
export function qualityNotesSuffix(notes: readonly QualityNote[]): string {
  if (!notes.length) return "";
  const blocking = notes.filter(isBlockingNote).length;
  return `; ${notes.length} quality note${notes.length === 1 ? "" : "s"}${blocking ? `, ${blocking} blocking` : ""}`;
}

/** "2 of 3 criteria met, 1 unclear": the same counts in the task's history and its pull request. */
export function acceptanceCounts(criteria: CriterionVerdict[]): string {
  const n = (v: CriterionVerdict["verdict"]) => criteria.filter((c) => c.verdict === v).length;
  const extra = [n("unmet") && `${n("unmet")} unmet`, n("unclear") && `${n("unclear")} unclear`].filter(Boolean);
  return `${n("met")} of ${criteria.length} criteria met${extra.length ? `, ${extra.join(", ")}` : ""}`;
}
