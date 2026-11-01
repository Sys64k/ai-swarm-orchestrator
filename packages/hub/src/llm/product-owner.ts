import type Anthropic from "@anthropic-ai/sdk";
import {
  createLogger,
  DIAGNOSIS_ACTIONS,
  DIAGNOSIS_CAUSES,
  DIAGNOSIS_SOURCES,
  type Acceptance,
  type Diagnosis,
  type LlmUsage,
  type TaskDiff,
  type TaskSpec,
} from "@aso/shared";
import type { LlmAdapter } from "./adapter.js";
import { diffText } from "./acceptance.js";
import { addToDay, spentOn, utcDay, type DaySpend } from "./conversations.js";
import { priceUsage } from "./pricing.js";
import type { TranscriptEntry } from "../transcripts.js";

const log = createLogger("product-owner");

/** Why nothing is diagnosed when it is turned off. */
export const PRODUCT_OWNER_OFF = "the product owner is off";
/** The product owner's spending per UTC day when none is configured: it stops for the day past it. */
export const DEFAULT_PRODUCT_OWNER_DAILY_USD = 5;
/** How much of each source it reads. */
const DIFF_LIMIT = 40_000;
const TRANSCRIPT_LIMIT = 40_000;
const HISTORY_EVENTS = 40;
const ENTRY_LIMIT = 1_500;
const QA_OUTPUT_LIMIT = 4_000;
/** The most evidence kept from an answer, and the longest quote. */
const MAX_EVIDENCE = 8;
const MAX_QUOTE = 600;

/** What the product owner reads of a failed task. */
export interface FailedTask {
  spec: Pick<TaskSpec, "taskId" | "title" | "description" | "acceptanceCriteria">;
  detail?: string;
  summary?: string;
  acceptance?: Acceptance;
  history: ReadonlyArray<{ at: string; event: string }>;
}

/** Whether `d` is the diagnosis of the task's current failure: the one a person can still act on. */
export function isCurrentDiagnosis(task: { state: string; retries?: number }, d: Pick<Diagnosis, "attempt"> | undefined): boolean {
  return task.state === "failed" && d?.attempt === (task.retries ?? 0);
}

/** A diagnosis that couldn't be made, and why. */
export function failedDiagnosis(attempt: number, error: string, extra: Pick<Diagnosis, "model" | "costUsd"> = {}): Diagnosis {
  return { attempt, state: "failed", at: new Date().toISOString(), error, ...extra };
}

/** Everything it is shown, by source, as the prompt shows it: its quotes are checked against these. */
export type Sources = Record<(typeof DIAGNOSIS_SOURCES)[number], string>;

// Its fields are snake_case like the other tools; readDiagnosis maps them to the stored Diagnosis
// (acceptance_criteria → acceptanceCriteria, issue_title/issue_body → issue).
const TOOL: Anthropic.Beta.BetaTool = {
  name: "report_diagnosis",
  description: "Report why the task failed, the evidence, and one proposal for the person.",
  input_schema: {
    type: "object",
    properties: {
      cause: { type: "string", enum: [...DIAGNOSIS_CAUSES], description: "task: the task or its criteria were wrong or unclear; model: the model couldn't do it; platform: ASO itself got in the way; unclear: the evidence doesn't say" },
      summary: { type: "string", description: "Two or three plain sentences for the person: what happened and why" },
      evidence: {
        type: "array",
        description: `What the diagnosis rests on, at most ${MAX_EVIDENCE}. Each quote copied exactly from the source it names, short.`,
        items: {
          type: "object",
          properties: {
            source: { type: "string", enum: [...DIAGNOSIS_SOURCES] },
            quote: { type: "string", description: `Copied character for character, at most ${MAX_QUOTE} characters` },
            note: { type: "string", description: "One sentence: what it shows" },
          },
          required: ["source", "quote"],
        },
      },
      proposal: {
        type: "object",
        properties: {
          action: { type: "string", enum: [...DIAGNOSIS_ACTIONS] },
          why: { type: "string", description: "One or two sentences" },
          description: { type: "string", description: "retry_with_correction: the whole corrected description, when it changes" },
          acceptance_criteria: { type: "array", items: { type: "string" }, description: "retry_with_correction: the whole corrected list of criteria, when they change" },
          issue_title: { type: "string", description: "platform_issue: the issue's title" },
          issue_body: { type: "string", description: "platform_issue: what went wrong, the evidence, and what ASO should do instead" },
        },
        required: ["action", "why"],
      },
    },
    required: ["cause", "summary", "evidence", "proposal"],
  },
};

const SYSTEM = `You are the product owner of an AI coding swarm (ASO). A task failed, and you tell the person who runs the
swarm why, so they can trust what it does without reading its logs. Read the evidence and decide the cause:
- task: the task's description or criteria were wrong, vague, contradicted the project's code, or asked for something the
  reviewer judged differently than the code could do. Then propose retry_with_correction, with the corrected description
  and/or the whole corrected list of criteria. Change only what was wrong.
- model: the task was clear and doable, and the model didn't manage it (logic errors, gave up, ran out of turns going in
  circles). Propose retry when another try is likely to work (say why), else dismiss or none.
- platform: ASO itself got in the way: its tools, the worker, QA's setup, the Hub, a provider being unreachable. Propose
  platform_issue with an issue for ASO's maintainers, or retry when it was a passing outage.
- unclear: the evidence doesn't show it. Propose none and say what is missing.
Be sceptical: the agent's own summary and claims are not proof; what the transcript, QA output and diff show is.
Cite evidence by copying short quotes exactly from the source you name; the Hub checks every quote against that source.
Answer only by calling report_diagnosis.`;

/** Text cut to `max` characters, keeping its start and end. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n… (${text.length - max} characters left out) …\n${text.slice(text.length - (max - head))}`;
}

/** A transcript entry as one compact line (or a few). */
export function transcriptLine(e: TranscriptEntry): string {
  switch (e.kind) {
    case "event":
      return `[event] ${e.text}`;
    case "text":
      return `[agent] ${cut(e.text, ENTRY_LIMIT)}`;
    case "thinking":
      return `[thinking] ${cut(e.text, ENTRY_LIMIT)}`;
    case "call":
      return `[call ${e.name}] ${cut(JSON.stringify(e.input), 300)}`;
    case "result":
      return `[result${e.name ? ` ${e.name}` : ""}${e.isError ? ", error" : ""}] ${cut(e.content, e.isError ? 2 * ENTRY_LIMIT : ENTRY_LIMIT)}`;
    case "qa":
      return `[qa ${e.outcome}] ${e.summary}${e.output ? `\n${cut(e.output, QA_OUTPUT_LIMIT)}` : ""}`;
  }
}

/** The end of the transcript that fits in `limit` characters, oldest first. */
export function transcriptTail(entries: readonly TranscriptEntry[], limit = TRANSCRIPT_LIMIT): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = transcriptLine(entries[i]);
    if (size + line.length > limit) break;
    lines.unshift(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** What the product owner is shown of a failed task, by source. */
/** Terminal colour and cursor codes (test runners' output): noise to a reader, and a quote of the visible text must still match. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const withoutAnsi = (s: string) => s.replace(ANSI, "");

export function failureSources(task: FailedTask, transcript: readonly TranscriptEntry[], diff: TaskDiff | undefined): Sources {
  const a = task.acceptance;
  const acceptance = a
    ? [
        `${a.result}${a.summary ? `: ${a.summary}` : ""}${a.reason ? ` (${a.reason})` : ""}`,
        ...(a.criteria ?? []).map((c) => `- ${c.verdict}: ${c.criterion} (${c.reason})`),
        ...(a.qualityNotes ?? []).map((n) => `- note ${n.kind}: ${n.note}`),
      ].join("\n")
    : "";
  const qa = transcript
    .filter((e): e is Extract<TranscriptEntry, { kind: "qa" }> => e.kind === "qa")
    .slice(-2)
    .map(transcriptLine)
    .join("\n");
  return {
    description: `${task.spec.title}\n\n${task.spec.description.trim()}`,
    criteria: task.spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    history: [...task.history.slice(-HISTORY_EVENTS).map((h) => `${h.at.slice(0, 19)} ${h.event}`), ...(task.detail ? [`failed: ${task.detail}`] : [])].join("\n"),
    transcript: withoutAnsi(transcriptTail(transcript.filter((e) => e.kind !== "qa"))),
    qa: withoutAnsi(qa),
    acceptance,
    diff: diff ? diffText(diff, DIFF_LIMIT).text : "",
  };
}

const HEADINGS: Record<keyof Sources, string> = {
  description: "The task (source: description)",
  criteria: "Its acceptance criteria (source: criteria)",
  history: "What happened to it, oldest first (source: history)",
  transcript: "The end of its agents' transcript (source: transcript)",
  qa: "The last QA runs (source: qa)",
  acceptance: "The last acceptance check (source: acceptance)",
  diff: "Its branch's change against main (source: diff)",
};

export function diagnosisPrompt(task: FailedTask, sources: Sources): string {
  const parts = (Object.keys(HEADINGS) as Array<keyof Sources>).filter((k) => sources[k].trim()).map((k) => `## ${HEADINGS[k]}\n${sources[k]}`);
  const claim = task.summary?.trim() ? [`## The agent's own last summary (a claim, not proof)\n${task.summary.trim()}`] : [];
  return [`Task ${task.spec.taskId} failed.`, ...parts, ...claim].join("\n\n");
}

/** Whitespace-insensitive: a quote copied across a line break still counts as found. */
const squash = (s: string) => withoutAnsi(s).replace(/\s+/g, " ").trim();
/** A non-empty string, trimmed, or undefined. */
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** What a model's answer says; the Hub adds the attempt, time, model and cost. */
export type DiagnosisReading = Pick<Diagnosis, "cause" | "summary" | "evidence" | "proposal">;

/** The quotes, each checked against the source it names. */
function readEvidence(raw: unknown, sources: Sources): NonNullable<Diagnosis["evidence"]> {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_EVIDENCE).flatMap((item) => {
    const e = item as Record<string, unknown>;
    const source = DIAGNOSIS_SOURCES.find((s) => s === e.source);
    const quote = str(e.quote)?.slice(0, MAX_QUOTE);
    if (!source || !quote) return [];
    const note = str(e.note);
    return [{ source, quote, ...(note ? { note } : {}), found: squash(sources[source]).includes(squash(quote)) }];
  });
}

/** The proposal, keeping only what its action needs; undefined when it can't be used. */
function readProposal(raw: unknown): NonNullable<Diagnosis["proposal"]> | { error: string } {
  const p = (raw ?? {}) as Record<string, unknown>;
  const action = DIAGNOSIS_ACTIONS.find((a) => a === p.action);
  const why = str(p.why);
  if (!action || !why) return { error: "the product owner's diagnosis is missing its cause, summary or proposal" };
  if (action === "retry_with_correction") {
    const description = str(p.description);
    const criteria = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria.map(str).filter((c): c is string => c !== undefined) : [];
    if (!description && !criteria.length) return { error: "the product owner proposed a correction without saying what to change" };
    return { action, why, ...(description ? { description } : {}), ...(criteria.length ? { acceptanceCriteria: criteria } : {}) };
  }
  const title = str(p.issue_title);
  const body = str(p.issue_body);
  return { action, why, ...(action === "platform_issue" && title && body ? { issue: { title, body } } : {}) };
}

/** The diagnosis in the model's answer (quotes checked against `sources`), or why it can't be read. */
export function readDiagnosis(content: Anthropic.Beta.BetaContentBlock[], sources: Sources): DiagnosisReading | { error: string } {
  const call = content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === TOOL.name);
  if (!call) return { error: "the product owner answered without a diagnosis" };
  const input = (call.input ?? {}) as Record<string, unknown>;
  const cause = DIAGNOSIS_CAUSES.find((c) => c === input.cause);
  const summary = str(input.summary);
  if (!cause || !summary) return { error: "the product owner's diagnosis is missing its cause, summary or proposal" };
  const proposal = readProposal(input.proposal);
  if ("error" in proposal) return proposal;
  return { cause, summary, evidence: readEvidence(input.evidence, sources), proposal };
}

export interface ProductOwnerOptions {
  /** USD per UTC day; past it, failures wait for the next day undiagnosed. 0 turns it off. */
  dailyUsd?: number;
  now?: () => Date;
}

/**
 * Reads why a task failed and proposes one thing to do about it, for a person to accept or
 * refuse. One model call per failure, on the models `models` gives (the first that answers),
 * within a daily budget.
 */
export class ProductOwner {
  private spent: DaySpend | undefined;

  constructor(
    private readonly models: () => Promise<ReadonlyArray<LlmAdapter | undefined>>,
    private readonly opts: ProductOwnerOptions = {},
  ) {}

  /** Why it can't diagnose now (off, or the day's budget is spent), or undefined when it can. */
  unavailable(): string | undefined {
    const daily = this.opts.dailyUsd ?? DEFAULT_PRODUCT_OWNER_DAILY_USD;
    if (!(daily > 0)) return PRODUCT_OWNER_OFF;
    const spent = spentOn(this.spent, utcDay(this.now()));
    return spent >= daily ? `the product owner's budget for today ($${daily.toFixed(2)}) is spent` : undefined;
  }

  /** The diagnosis, and what its model call used (to count on the task), if one answered. */
  async diagnose(task: FailedTask, sources: Sources, attempt: number): Promise<{ diagnosis: Diagnosis; usage?: LlmUsage }> {
    const adapters = (await this.models()).filter((a, i, all): a is LlmAdapter => a !== undefined && all.findIndex((b) => b?.model === a.model) === i);
    if (!adapters.length) return { diagnosis: failedDiagnosis(attempt, "no model is configured") };
    const failures: string[] = [];
    for (const adapter of adapters) {
      let response;
      try {
        response = await adapter.complete({ system: SYSTEM, tools: [TOOL], messages: [{ role: "user", content: diagnosisPrompt(task, sources) }] });
      } catch (err) {
        failures.push(`${adapter.model}: ${(err as Error).message}`);
        continue;
      }
      const usage = priceUsage(response.model, response.tokens);
      const costUsd = usage.costUsd;
      this.spent = addToDay(this.spent, utcDay(this.now()), costUsd);
      const read = readDiagnosis(response.content, sources);
      if ("error" in read) return { diagnosis: failedDiagnosis(attempt, read.error, { model: adapter.model, costUsd }), usage };
      log.info(`${task.spec.taskId}: ${read.cause}; proposes ${read.proposal?.action} ($${costUsd.toFixed(3)})`);
      return { diagnosis: { attempt, state: "ready", at: this.now().toISOString(), model: adapter.model, costUsd, ...read }, usage };
    }
    return { diagnosis: failedDiagnosis(attempt, `every model failed: ${failures.join("; ")}`) };
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }
}
