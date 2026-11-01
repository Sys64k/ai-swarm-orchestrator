import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@aso/shared";

const log = createLogger("transcripts");

/** Entries kept in memory per transcript; the file on disk keeps everything. */
const MEMORY_LIMIT = 1000;
/** Longest text stored per entry; longer output keeps its start and (mostly) its end. */
const TEXT_LIMIT = 8000;
const INPUT_STRING_LIMIT = 2000;
const SAFE_KEY = /^(task|plan)-[A-Za-z0-9_-]{1,128}$/;

/** One line of what happened in a task or plan, in the order it happened. */
export type TranscriptEntry = { seq: number; at: string } & (
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "call"; id: string; name: string; input: Record<string, unknown> }
  | { kind: "result"; id: string; name?: string; content: string; isError: boolean }
  | { kind: "event"; text: string }
  | { kind: "qa"; outcome: "pass" | "fail"; summary: string; output?: string }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TranscriptInput = DistributiveOmit<TranscriptEntry, "seq" | "at">;

export type TranscriptSubject = { kind: "task" | "plan"; id: string };

interface Log {
  entries: TranscriptEntry[];
  nextSeq: number;
}

/**
 * The live record behind the console's terminal view: the agent's text, every tool call with
 * its (trimmed) result, Hub events and QA verdicts. Kept in memory for reading and appended to
 * `<stateDir>/transcripts/<kind>-<id>.jsonl`, so finished tasks keep theirs across restarts.
 */
export class Transcripts {
  private readonly logs = new Map<string, Log>();
  private writes: Promise<unknown> = Promise.resolve();
  private closed = false;

  /** `dir` undefined keeps transcripts in memory only. */
  constructor(private readonly dir?: string) {}

  append(subject: TranscriptSubject, input: TranscriptInput): void {
    const key = keyOf(subject);
    if (!key) return;
    const log = this.open(key);
    const entry = { ...trim(input), seq: log.nextSeq++, at: new Date().toISOString() } as TranscriptEntry;
    log.entries.push(entry);
    if (log.entries.length > MEMORY_LIMIT) log.entries.splice(0, log.entries.length - MEMORY_LIMIT);
    if (this.dir && !this.closed) {
      const file = path.join(this.dir, `${key}.jsonl`);
      const line = JSON.stringify(entry) + "\n";
      this.writes = this.writes
        .then(() => mkdir(this.dir!, { recursive: true }))
        .then(() => appendFile(file, line))
        .catch((err: Error) => logError(err));
    }
  }

  /** Entries with `seq` greater than `after` (all when omitted), oldest first, at most `limit`. */
  read(subject: TranscriptSubject, after = -1, limit = 500): { entries: TranscriptEntry[]; last: number } {
    const key = keyOf(subject);
    if (!key) return { entries: [], last: -1 };
    const log = this.open(key);
    const entries = log.entries.filter((e) => e.seq > after).slice(0, limit);
    return { entries, last: log.nextSeq - 1 };
  }

  /** Wait for pending writes (tests). */
  flush(): Promise<unknown> {
    return this.writes;
  }

  /** Write what is pending, then keep later entries in memory only (the Hub is shutting down). */
  async close(): Promise<void> {
    this.closed = true;
    await this.writes;
  }

  /** The in-memory log, loaded from disk the first time a key is used in this process. */
  private open(key: string): Log {
    let log = this.logs.get(key);
    if (log) return log;
    log = { entries: [], nextSeq: 0 };
    if (this.dir) {
      try {
        const lines = readFileSync(path.join(this.dir, `${key}.jsonl`), "utf8").split("\n").filter(Boolean);
        for (const line of lines.slice(-MEMORY_LIMIT)) {
          try {
            log.entries.push(JSON.parse(line) as TranscriptEntry);
          } catch {
            /* a torn last line from a crash */
          }
        }
        log.nextSeq = (log.entries.at(-1)?.seq ?? -1) + 1;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") logError(err as Error);
      }
    }
    this.logs.set(key, log);
    return log;
  }
}

function keyOf(subject: TranscriptSubject): string | undefined {
  const key = `${subject.kind}-${subject.id}`;
  return SAFE_KEY.test(key) ? key : undefined;
}

function trim(input: TranscriptInput): TranscriptInput {
  switch (input.kind) {
    case "text":
    case "thinking":
    case "event":
      return { ...input, text: clip(input.text) };
    case "result":
      return { ...input, content: clip(input.content) };
    case "qa":
      return { ...input, output: input.output === undefined ? undefined : clip(input.output) };
    case "call":
      return {
        ...input,
        input: Object.fromEntries(
          Object.entries(input.input).map(([k, v]) => [
            k,
            typeof v === "string" && v.length > INPUT_STRING_LIMIT ? `${v.slice(0, INPUT_STRING_LIMIT)}… (${v.length} chars)` : v,
          ]),
        ),
      };
  }
}

/** Keep the start (what ran) and the end (how it ended) of long output. */
function clip(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  const head = text.slice(0, 1500);
  const tail = text.slice(-(TEXT_LIMIT - 1500));
  return `${head}\n… (${text.length - TEXT_LIMIT} characters skipped)\n${tail}`;
}

function logError(err: Error): void {
  log.error(`saving a transcript failed: ${err.message}`);
}
