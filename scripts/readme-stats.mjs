#!/usr/bin/env node
/**
 * Refreshes the swarm's stats in the README from a Hub's public stats (`aso start-hub
 * --public-stats …`, served at `/api/public-stats`): the text between the two markers below.
 * Run by .github/workflows/swarm-stats.yml once a day:
 *   node scripts/readme-stats.mjs https://<hub>/api/public-stats [README.md] [history.jsonl]
 * With a history file, it also keeps the day's stats there, a JSON line per day, for charts.
 * An unreachable Hub leaves the README as it is (and exits 0): the next run tries again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const START = "<!-- swarm-stats:start -->";
export const END = "<!-- swarm-stats:end -->";

/**
 * A model's name for people: without the provider's prefix (`models/gemini-3.8-flash` →
 * `gemini-3.8-flash`), and only characters that can't break the table or carry Markdown.
 */
export function modelLabel(spec) {
  return String(spec).split("/").at(-1).replace(/[^A-Za-z0-9._:@+ '-]/g, "").trim() || "a model";
}

/** Whether an answer has the shape this script reads (anything else skips the day). */
export function looksLikeStats(s) {
  const n = (v) => typeof v === "number" && Number.isFinite(v);
  return !!s && typeof s.at === "string" && !!s.tasks && n(s.tasks.finished) && n(s.tasks.firstTry) && !!s.plans && n(s.plans.proposed) && (s.models === undefined || Array.isArray(s.models));
}

const percent = (good, all) => (all ? `${Math.round((good / all) * 100)}%` : "–");
/** "3 of 4", or "–" when there were none. */
const ratio = (good, all) => (all ? `${good} of ${all}` : "–");
const usd = (n) => (n === undefined ? "–" : `$${n.toFixed(2)}`);
const day = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The section's Markdown, from the Hub's public stats. */
export function renderStats(stats) {
  const t = stats.tasks;
  if (!t.finished && !stats.plans.proposed) {
    return "**Built by its own swarm.** The swarm's track record appears here once it has finished its first tasks.";
  }
  const since = stats.since ? `Since ${day(stats.since)}, the` : "The";
  const headline = [
    `**Built by its own swarm.** ${since} swarm has merged **${t.finished} task${t.finished === 1 ? "" : "s"}**`,
    t.finished ? `, **${percent(t.firstTry, t.finished)}** on the first try` : "",
    t.tookOver ? ` (${t.tookOver} finished by a stronger model taking over)` : "",
    stats.plans.proposed ? `, from **${stats.plans.approved} of ${stats.plans.proposed}** proposed plans approved` : "",
    stats.costs?.perTaskUsd !== undefined ? `, at about **${usd(stats.costs.perTaskUsd)} per task** in model costs` : "",
    ".",
  ].join("");
  const lines = [headline];
  const models = (stats.models ?? []).filter((m) => m.builds || m.plansProposed || m.checks);
  if (models.length) {
    const withCost = models.some((m) => m.costPerTaskUsd !== undefined || m.costUsd !== undefined);
    const header = ["Model", "Tasks finished", "First try", "QA passed", "Acceptance met", "Plans approved", "Checks it made: met", "Its met held up", ...(withCost ? ["Cost per task started on it"] : [])];
    lines.push("", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
    for (const m of models) {
      const cells = [
        `\`${modelLabel(m.model)}\``,
        String(m.finished),
        percent(m.firstTry, m.finished),
        ratio(m.qaPassed, m.qaPassed + m.qaFailed),
        ratio(m.accepted, m.accepted + m.unmet),
        ratio(m.plansApproved, m.plansProposed),
        ratio(m.checksMet, m.checks),
        // A Hub from before overturns were counted doesn't say.
        m.checksOverturned === undefined ? "–" : ratio(m.checksMet - m.checksOverturned, m.checksMet),
        ...(withCost ? [usd(m.costPerTaskUsd)] : []),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    }
    if (models.some((m) => m.checks)) lines.push("", "<sub>Its met held up: of the work it passed as the reviewer, how much no person sent back or closed and whose deploy didn't fail.</sub>");
    if (withCost) lines.push("", "<sub>Cost per task started on it: all in, from a task's first build to its end (every model it escalated to, its acceptance checks, a share of its plan), and failed tasks too.</sub>");
  }
  lines.push("", `<sub>From the Hub's public track record, updated daily (last: ${day(stats.at)}). See [Track records](docs/models.md#track-records-how-each-model-has-done).</sub>`);
  return lines.join("\n");
}

/** The README with the section between the markers replaced; undefined when the markers are missing. */
export function replaceSection(readme, markdown) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) return undefined;
  return `${readme.slice(0, start + START.length)}\n${markdown}\n${readme.slice(end)}`;
}

/**
 * The stats history (a JSON line per day, oldest first) with `stats` as its day's line: added,
 * or in place of an earlier one from the same day (UTC). Lines that aren't stats are dropped.
 */
export function withSnapshot(history, stats) {
  const day = (s) => s.at.slice(0, 10);
  const byDay = new Map();
  for (const line of history.split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (looksLikeStats(s)) byDay.set(day(s), s);
    } catch {
      // A broken line is skipped; the rest of the history stays.
    }
  }
  byDay.set(day(stats), stats);
  return [...byDay.keys()].sort().map((d) => `${JSON.stringify(byDay.get(d))}\n`).join("");
}

async function main() {
  const [url, file = "README.md", historyFile] = process.argv.slice(2);
  if (!url) throw new Error("usage: node scripts/readme-stats.mjs <public stats URL> [README.md] [history.jsonl]");
  let stats;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    stats = await res.json();
    if (!looksLikeStats(stats)) throw new Error("the answer isn't the Hub's public stats");
  } catch (err) {
    console.log(`the Hub's stats couldn't be read (${err.message}); the README stays as it is`);
    return;
  }
  if (historyFile) {
    mkdirSync(path.dirname(historyFile), { recursive: true });
    writeFileSync(historyFile, withSnapshot(existsSync(historyFile) ? readFileSync(historyFile, "utf8") : "", stats));
  }
  const readme = readFileSync(file, "utf8");
  const next = replaceSection(readme, renderStats(stats));
  if (next === undefined) throw new Error(`${file} has no ${START} … ${END} section`);
  if (next === readme) return console.log("the stats haven't changed");
  writeFileSync(file, next);
  console.log(`updated the swarm's stats in ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
