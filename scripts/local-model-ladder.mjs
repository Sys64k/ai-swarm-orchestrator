#!/usr/bin/env node
/**
 * The local-model ladder (docs/local-model-experiment.md): five tasks of rising difficulty, run
 * on one model, one at a time, each pinned to it (no escalation) and tagged with its level.
 *
 *   node scripts/local-model-ladder.mjs <provider>/<model> [--tests-first] [--variant A]
 *        [--project ladder-<model>] [--from ~/aso-projects/aso-test] [--base 9cac1e3] [--hub 127.0.0.1]
 *
 * Every run gets a fresh project (`ladder-<model>`, or `--project`) seeded with aso-test as it
 * was before the first ladder (`--base`), so every model faces the same tasks from the same code.
 * Run it on the Hub's machine: it seeds the project's folder there. Prints a table of the results
 * for the experiment page. Needs `npm run build` (it uses the CLI's Hub client).
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** aso-test's main before the first ladder ran (2026-10-29): every run starts from it. */
export const BASE_COMMIT = "9cac1e3";

/** Task outcomes the run waits for. */
const ENDED = ["merged", "failed", "cancelled"];

/** The acceptance criterion every ladder task shares. */
const KEEP = "All existing tests still pass (`npm test`), and `npm run typecheck` and `npm run lint` are clean.";

/**
 * The tasks, by variant: A is the ladder new models run. B, C and D are the other variants the
 * first four models ran on a shared project (each had to do different work there, as each merged).
 * Each task: [title, description, criteria, files].
 */
export const LADDER = {
  A: [
    ["Word count helper", "Add `countWords(text: string): number` in a new `lib/text/wordCount.ts`, with tests in `lib/text/wordCount.test.ts`. Words are runs of letters or digits; hyphenated words (`well-known`) and apostrophes (`don't`) count as one word.", ["Empty or whitespace-only text gives 0", "Punctuation alone is not a word", "`well-known` and `don't` each count as one word", "Numbers count as words"], ["lib/text/wordCount.ts", "lib/text/wordCount.test.ts"]],
    // Fixed after two models failed it on our criterion, which asked for a cut the code never made and was read as 60 with the "…" included.
    ["Tidy document titles on save", "`saveDocument` in `lib/documents.ts` should tidy a title it is given: trim it, collapse runs of whitespace inside it to one space, and cut one longer than `TITLE_MAX_LENGTH` the way `deriveTitle` already cuts text-derived titles (at a word boundary when there is one, else at 60 characters, then `…`). The project's convention is 60 characters plus the `…`, as its `deriveTitle` tests show. Today a given title is only trimmed, never cut. A given title is never split into sentences: only text-derived titles are. Reuse `deriveTitle`'s cutting rather than copying it. Add tests to `lib/documents.test.ts`.", ["`'  My   doc  '` is saved as `'My doc'`", "A title that is only whitespace falls back to `deriveTitle(text)`, as an empty one does today", "A given title longer than TITLE_MAX_LENGTH is cut as `deriveTitle` cuts: 60 characters plus `…`, the project's convention", "The cutting is shared with `deriveTitle`, not copied", "The new behaviour has tests in `lib/documents.test.ts`"], ["lib/documents.ts", "lib/documents.test.ts"]],
    ["Backup export and import", "Add `lib/backup.ts` with `exportBackup(storage?)`, returning a JSON string holding every saved document and the reader settings, and `importBackup(json, storage?)`, which restores them: documents merged by id (the imported one wins), at most `MAX_DOCUMENTS` kept (newest first), settings passed through `sanitizeSettings`. Invalid JSON throws an Error with a clear message and changes nothing. Tests in `lib/backup.test.ts`.", ["A backup round-trips: export then import into empty storage gives the same documents and settings", "Import merges by id and keeps at most MAX_DOCUMENTS", "Bad settings in a backup are sanitized", "Invalid JSON throws and leaves storage unchanged"], ["lib/backup.ts", "lib/backup.test.ts"]],
    ["Clear all recent documents", "Add a `Clear all` button to `components/reader/RecentDocuments.tsx`, shown only when there are documents. It opens a confirmation using the existing `Modal`; confirming removes every saved document (add `clearDocuments(storage?)` to `lib/documents.ts`), cancelling changes nothing. Tests with Testing Library.", ["The button is hidden with no documents", "Confirming clears the list and storage", "Cancelling keeps every document", "The dialog is keyboard accessible: focus moves into it and Escape closes it"], ["components/reader/RecentDocuments.tsx", "lib/documents.ts"]],
    ["Text statistics before reading", "Add `POST /api/stats` (`app/api/stats/route.ts`) taking `{ text }` (at most 200 000 characters, else 413) and answering `{ words, sentences, paragraphs, minutes }`, using `splitParagraphs`/`splitSentences` from `lib/text/segment.ts` and 200 words a minute (rounded up). In `components/input/ImportPanel.tsx`, show those numbers under pasted text once it is at least 20 characters, fetched from the route. Tests for the route and the panel (mock fetch).", ["The route answers the four numbers for valid text", "Missing or non-string text gives 400; too long gives 413", "The panel shows the numbers for pasted text and nothing for short text", "A failing request shows no numbers and no error dialog"], ["app/api/stats/route.ts", "components/input/ImportPanel.tsx"]],
  ],
  B: [
    ["Reading time helper", "Add `readingMinutes(text: string, wordsPerMinute = 200): number` in a new `lib/text/readingTime.ts`, with tests in `lib/text/readingTime.test.ts`. It rounds up to whole minutes, gives 0 for text without words, and throws a RangeError when wordsPerMinute is not a positive number.", ["Empty text gives 0", "201 words at 200 wpm gives 2", "A custom wpm is used", "wpm 0, negative or NaN throws RangeError"], ["lib/text/readingTime.ts", "lib/text/readingTime.test.ts"]],
    ["Font size given as text", "`sanitizeSettings` in `lib/settings.ts` should accept `fontSize`, `lineHeight` and `rate` given as numeric strings (`\"24\"`), clamping them like numbers; any other string still falls back to the default. Add tests to `lib/settings.test.ts`.", ["`fontSize: \"24\"` gives 24", "`fontSize: \"500\"` is clamped to the maximum", "`fontSize: \"big\"` gives the default", "Existing settings tests still pass"], ["lib/settings.ts", "lib/settings.test.ts"]],
    ["Document statistics", "Add `documentStats(text)` in a new `lib/text/stats.ts`, returning `{ paragraphs, sentences, words, characters }` using `splitParagraphs` and `splitSentences` from `lib/text/segment.ts` (characters without whitespace). Tests in `lib/text/stats.test.ts`.", ["Empty text gives all zeros", "Counts match for a two-paragraph text with several sentences", "Whitespace isn't counted in characters"], ["lib/text/stats.ts", "lib/text/stats.test.ts"]],
    ["Copy the document's text", "Add a `Copy text` button to the reader (`components/reader/ReaderView.tsx` or its controls) that copies the open document's text with `navigator.clipboard.writeText` and announces `Copied` through the existing `Announcer`; if copying fails it announces `Couldn't copy`. Tests with Testing Library (mock the clipboard).", ["Clicking copies the document's text", "Success announces Copied", "A failing clipboard announces Couldn't copy", "The button has an accessible name"], ["components/reader/ReaderView.tsx"]],
    ["Truncated extraction notice", "`POST /api/extract` takes an optional `maxChars` (100 to 200 000; outside that 400). When the extracted text is longer it is cut to `maxChars` at a word boundary and the answer has `truncated: true`. `components/input/ImportPanel.tsx` sends `maxChars: 50000` and shows a notice `Only the first part of this page was imported` when truncated. Tests for the route and the panel.", ["maxChars cuts long text at a word boundary and sets truncated", "Text within the limit has no truncated flag", "maxChars outside 100–200000 gives 400", "The panel shows the notice only when truncated"], ["app/api/extract/route.ts", "components/input/ImportPanel.tsx"]],
  ],
  C: [
    ["Truncate to a number of words", "Add `truncateWords(text: string, max: number): string` in a new `lib/text/truncate.ts`, with tests in `lib/text/truncate.test.ts`. Text with more than `max` words is cut after the `max`th word and ends with `…`; shorter text comes back unchanged; `max` below 1 throws a RangeError.", ["Text within the limit is unchanged", "Longer text keeps max words and ends with …", "Whitespace between kept words is kept as it was", "max 0 or negative throws RangeError"], ["lib/text/truncate.ts", "lib/text/truncate.test.ts"]],
    ["Strip zero-width characters", "`normalizeText` in `lib/text/segment.ts` should remove zero-width characters (U+200B, U+200C, U+200D, U+FEFF) so they aren't read aloud or counted. Add tests to `lib/text/segment.test.ts`.", ["Each of the four characters is removed", "Text without them is unchanged", "Existing segment tests still pass"], ["lib/text/segment.ts", "lib/text/segment.test.ts"]],
    ["Search saved documents", "Add `searchDocuments(query, storage?)` to `lib/documents.ts`: case-insensitive matches in title, text or note; title matches first, then the rest, each group newest first; an empty or whitespace query returns every document. Tests in `lib/documents.test.ts` (create it if missing).", ["Matches title, text and note, ignoring case", "Title matches come before text matches", "An empty query returns all documents", "No match returns an empty list"], ["lib/documents.ts"]],
    ["Rename a recent document", "In `components/reader/RecentDocuments.tsx`, each document gets a `Rename` button that turns its title into a text field; Enter or blur saves (add `renameDocument(id, title, storage?)` to `lib/documents.ts`, trimming and respecting `TITLE_MAX_LENGTH`), Escape cancels, an empty title isn't saved. Tests with Testing Library.", ["Rename, type and Enter saves the new title", "Escape keeps the old title", "An empty title isn't saved", "The field has an accessible label"], ["components/reader/RecentDocuments.tsx", "lib/documents.ts"]],
    ["Server status in the footer", "`GET /api/health` also answers `version` (`APP_VERSION` from `lib/version.ts`) and `uptimeSec` (whole seconds since the server started). The footer (`components/reader/Footer.tsx`) shows a small status, `Online` or `Offline`, from fetching `/api/health` once on load (a failing fetch is Offline), with text, not colour alone. Tests for the route and the footer (mock fetch).", ["The route answers status, version and uptimeSec", "The footer shows Online when the route answers ok", "The footer shows Offline when the fetch fails", "The existing version label is unchanged"], ["app/api/health/route.ts", "components/reader/Footer.tsx"]],
  ],
  D: [
    ["Title case helper", "Add `titleCase(text: string): string` in a new `lib/text/titleCase.ts`, with tests in `lib/text/titleCase.test.ts`. Each word starts with a capital and the rest is lower case, except small words (`a`, `an`, `and`, `of`, `the`, `to`, `in`) that aren't first or last.", ["`the lord of the rings` gives `The Lord of the Rings`", "Single words are capitalised", "Empty text stays empty", "Extra spaces are kept"], ["lib/text/titleCase.ts", "lib/text/titleCase.test.ts"]],
    ["Short hex colours", "`relativeLuminance` in `lib/themes.ts` should accept 3-digit hex colours (`#fff`) as well as 6-digit ones, and throw an Error for anything else. Add tests to `lib/themes.test.ts`.", ["`#fff` and `#ffffff` give the same value", "`#000` gives 0", "`fff`, `#ff` and `#gggggg` throw", "Existing theme tests still pass"], ["lib/themes.ts", "lib/themes.test.ts"]],
    ["Settings presets", "Add `lib/presets.ts` with `SETTINGS_PRESETS` (`large-print`: font size 40, line height 2; `dyslexia-friendly`: font `lexend`, letter spacing 0.12, word spacing 0.3, line height 2) and `applyPreset(settings, name)`, returning new settings with the preset's values and everything else kept, passed through `sanitizeSettings`. An unknown name throws. Tests in `lib/presets.test.ts`.", ["Each preset sets its values and keeps the rest", "The input settings aren't changed", "An unknown preset name throws"], ["lib/presets.ts", "lib/presets.test.ts"]],
    ["Pin recent documents", "Each document in `components/reader/RecentDocuments.tsx` gets a `Pin`/`Unpin` button; pinned documents are listed first. Add `pinned?: boolean` to saved documents and `togglePin(id, storage?)` to `lib/documents.ts`; pinned ones are never dropped by the `MAX_DOCUMENTS` limit. Tests with Testing Library.", ["Pin moves a document to the top and persists", "Unpin returns it to date order", "Pinned documents survive the MAX_DOCUMENTS limit", "The button says Pin or Unpin to screen readers"], ["components/reader/RecentDocuments.tsx", "lib/documents.ts"]],
    ["Clean up pasted text", "Add `POST /api/normalize` (`app/api/normalize/route.ts`) taking `{ text }` (at most 200 000 characters, else 413) and answering `{ text, removedChars }` using `normalizeText` from `lib/text/segment.ts`. `components/input/ImportPanel.tsx` gets a `Clean up text` button for pasted text that calls it and replaces the text with the answer. Tests for the route and the panel (mock fetch).", ["The route answers normalized text and how many characters went", "Missing text gives 400; too long gives 413", "The button replaces the pasted text with the cleaned one", "A failing request keeps the text and says so"], ["app/api/normalize/route.ts", "components/input/ImportPanel.tsx"]],
  ],
};


/** A model's spec as a name for ids: `local/qwen3-coder:30b` → `qwen3-coder-30b`. */
export function modelTag(model) {
  return model.replace(/^[a-z0-9_.-]+\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "");
}

/** The ladder's tasks for a model, as `POST /api/tasks` bodies. */
export function ladderTasks(model, { variant = "A", project, testsFirst = false } = {}) {
  const tasks = LADDER[variant];
  if (!tasks) throw new Error(`no variant ${variant}: use ${Object.keys(LADDER).join(", ")}`);
  const tag = modelTag(model);
  return tasks.map(([title, description, criteria, files], i) => ({
    project,
    taskId: `ladder-${tag}-l${i + 1}${testsFirst ? "-tf" : ""}`,
    role: "frontend",
    kind: "feature",
    title,
    description,
    acceptanceCriteria: [...criteria, KEEP],
    files,
    level: i + 1,
    model,
    ...(testsFirst ? { testsFirst: true } : {}),
  }));
}

/** One finished task as a row: how it ended, on which try, how long, what it cost. */
export function resultRow(task, minutes) {
  const tries = task.reworkRound + 1;
  const outcome = task.state === "merged" ? `✅ ${tries === 1 ? "1st try" : `try ${tries}`}` : `❌ ${task.state}`;
  return { level: task.spec.level, title: task.spec.title, outcome, minutes, costUsd: task.llm.costUsd };
}

/** The results as a Markdown table for docs/local-model-experiment.md. */
export function resultsTable(model, rows, { testsFirst = false } = {}) {
  return [
    `\`${model}\`${testsFirst ? " (tests first)" : ""}:`,
    "",
    "| Level | Task | Result | Minutes | Cost |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.level} | ${r.title} | ${r.outcome} | ${r.minutes} | $${r.costUsd.toFixed(2)} |`),
  ].join("\n");
}

function parseArgs(argv) {
  const opts = { variant: "A", testsFirst: false, base: BASE_COMMIT, from: path.join(homedir(), "aso-projects", "aso-test"), hub: process.env.ASO_HUB || "127.0.0.1" };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tests-first") opts.testsFirst = true;
    else if (["--variant", "--project", "--from", "--base", "--hub"].includes(a)) opts[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error("usage: node scripts/local-model-ladder.mjs <provider>/<model> [--tests-first] [--variant A] [--project name] [--from repo] [--base commit] [--hub address]");
  return { ...opts, model: rest[0] };
}

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/**
 * A fresh project for the run, seeded with `from` at `base`. The Hub creates it with one empty
 * commit (a run that stopped before seeding leaves one like that, and it's used again); only
 * then, and only in that folder, is its main moved to the base.
 */
async function freshProject(call, name, from, base) {
  await call("/api/projects", { method: "POST", body: JSON.stringify({ name }) }).catch((err) => {
    if (err.status !== 409) throw err;
  });
  const dir = path.join(path.dirname(from), name);
  if (git(dir, "rev-list", "--count", "HEAD") !== "1") throw new Error(`${dir} isn't a new, empty project: not touching it`);
  // Another repository's commit can only be fetched by its full id.
  git(dir, "fetch", "--quiet", from, git(from, "rev-parse", `${base}^{commit}`));
  git(dir, "reset", "--quiet", "--hard", "FETCH_HEAD");
  return name;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { api } = await import("../packages/cli/dist/hub-api.js");
  const { hubHttpBase } = await import("@aso/shared");
  const base = hubHttpBase(opts.hub);
  const call = (route, init) => api(base, route, init);
  const name = opts.project ?? `ladder-${modelTag(opts.model)}${opts.testsFirst ? "-tf" : ""}`;
  const project = await freshProject(call, name, opts.from, opts.base);
  console.log(`project ${project}: ${opts.from} at ${opts.base}`);

  const rows = [];
  for (const task of ladderTasks(opts.model, { variant: opts.variant, project, testsFirst: opts.testsFirst })) {
    const started = Date.now();
    await call("/api/tasks", { method: "POST", body: JSON.stringify(task) });
    console.log(`level ${task.level}: ${task.title} (${task.taskId})`);
    for (;;) {
      await new Promise((r) => setTimeout(r, 30_000));
      const t = await call(`/api/tasks/${task.taskId}`).catch(() => undefined);
      if (t && ENDED.includes(t.state)) {
        const row = resultRow(t, Math.round((Date.now() - started) / 60_000));
        console.log(`  ${row.outcome}, ${row.minutes} min`);
        rows.push(row);
        break;
      }
    }
  }
  console.log(`\n${resultsTable(opts.model, rows, { testsFirst: opts.testsFirst })}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
