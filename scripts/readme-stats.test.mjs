import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { END, looksLikeStats, modelLabel, renderStats, replaceSection, START, withSnapshot } from "./readme-stats.mjs";

const stats = {
  since: "2026-10-27T12:10:00.000Z",
  at: "2026-11-03T05:00:00.000Z",
  tasks: { finished: 42, firstTry: 30, tookOver: 8 },
  plans: { proposed: 14, approved: 12 },
  costs: { totalUsd: 13.02, perTaskUsd: 0.31 },
  models: [
    { model: "gemini/models/gemini-3.8-flash", finished: 34, firstTry: 26, tookOver: 0, builds: 50, qaPassed: 30, qaFailed: 4, accepted: 28, unmet: 3, plansProposed: 0, plansApproved: 0, checks: 0, checksMet: 0, costUsd: 7.5, costPerTaskUsd: 0.22 },
    { model: "claude-opus-5-5", finished: 8, firstTry: 0, tookOver: 8, builds: 8, qaPassed: 8, qaFailed: 0, accepted: 8, unmet: 0, plansProposed: 14, plansApproved: 12, checks: 40, checksMet: 34, checksOverturned: 2, costUsd: 5.52 },
    { model: "idle-model", finished: 0, firstTry: 0, tookOver: 0, builds: 0, qaPassed: 0, qaFailed: 0, accepted: 0, unmet: 0, plansProposed: 0, plansApproved: 0, checks: 0, checksMet: 0 },
  ],
};

describe("the swarm's stats in the README", () => {
  it("says the totals in a sentence, and each model in a table", () => {
    const md = renderStats(stats);
    assert.match(
      md,
      /^\*\*Built by its own swarm\.\*\* Since 27 Oct 2026, the swarm has merged \*\*42 tasks\*\*, \*\*71%\*\* on the first try \(8 finished by a stronger model taking over\), from \*\*12 of 14\*\* proposed plans approved, at about \*\*\$0\.31 per task\*\* in model costs\./,
    );
    assert.match(md, /\| Model \| Tasks finished \| First try \| QA passed \| Acceptance met \| Plans approved \| Checks it made: met \| Its met held up \| Cost per task started on it \|/);
    assert.match(md, /Its met held up: of the work it passed/, "says what held up means");
    assert.match(md, /Cost per task started on it: all in/, "says what the cost covers");
    assert.match(md, /\| `gemini-3\.8-flash` \| 34 \| 76% \| 30 of 34 \| 28 of 31 \| – \| – \| – \| \$0\.22 \|/);
    assert.match(md, /\| `claude-opus-5-5` \| 8 \| 0% \| 8 of 8 \| 8 of 8 \| 12 of 14 \| 34 of 40 \| 32 of 34 \| – \|/, "2 of its 34 met verdicts were overturned");
    const older = renderStats({ ...stats, models: stats.models.map(({ checksOverturned, ...m }) => m) });
    assert.match(older, /\| 34 of 40 \| – \| – \|/, "a Hub from before overturns were counted doesn't say");
    assert.ok(!md.includes("idle-model"), "a model that did nothing isn't listed");
    assert.match(md, /last: 3 Nov 2026/);
  });

  it("shares only what the Hub shares: no table without models, no costs without costs", () => {
    const totalsOnly = renderStats({ ...stats, models: undefined, costs: undefined });
    assert.ok(!totalsOnly.includes("|") && !totalsOnly.includes("$"));
    const noCosts = renderStats({ ...stats, costs: undefined, models: stats.models.map(({ costUsd, costPerTaskUsd, ...m }) => m) });
    assert.ok(!noCosts.includes("Cost per task") && !noCosts.includes("$"));
    assert.match(renderStats({ ...stats, tasks: { finished: 0, firstTry: 0, tookOver: 0 }, plans: { proposed: 0, approved: 0 } }), /appears here once it has finished its first tasks/);
  });

  it("replaces only the marked section, and nothing without the markers", () => {
    const readme = `# ASO\n\nIntro.\n\n${START}\nold numbers\n${END}\n\n## More\n`;
    assert.equal(replaceSection(readme, "new numbers"), `# ASO\n\nIntro.\n\n${START}\nnew numbers\n${END}\n\n## More\n`);
    assert.equal(replaceSection("# no markers", "x"), undefined);
    assert.equal(modelLabel("openai/gpt-5.4-mini"), "gpt-5.4-mini");
  });

  it("never lets a model's name break the table or carry Markdown, and skips an answer of another shape", () => {
    for (const evil of ["x/evil` | [link](http://e)\n## Owned", "a|b", "<img src=x onerror=y>", "**bold**"]) {
      assert.doesNotMatch(modelLabel(evil), /[`|\[\]()<>*#\n\\]/, evil);
    }
    assert.equal(modelLabel("|`"), "a model");
    assert.ok(looksLikeStats(stats));
    for (const bad of [null, {}, { at: "t" }, { at: "t", tasks: { finished: "1" }, plans: { proposed: 0 } }, { ...stats, models: "x" }]) assert.equal(looksLikeStats(bad), false, JSON.stringify(bad));
  });

  it("keeps a line per day in the history: the day's latest, oldest first, past broken lines", () => {
    const day = (at, finished) => ({ ...stats, at, tasks: { ...stats.tasks, finished } });
    const first = withSnapshot("", day("2026-11-03T05:00:00.000Z", 42));
    assert.equal(first, `${JSON.stringify(day("2026-11-03T05:00:00.000Z", 42))}\n`);
    const again = withSnapshot(first, day("2026-11-03T09:00:00.000Z", 43));
    assert.deepEqual(again.trim().split("\n").map((l) => JSON.parse(l).tasks.finished), [43], "a rerun the same day replaces it");
    const older = `${JSON.stringify(day("2026-11-01T05:00:00.000Z", 40))}\nnot json\n{"at":"x"}\n`;
    const all = withSnapshot(older + again, day("2026-11-04T05:00:00.000Z", 45));
    assert.deepEqual(all.trim().split("\n").map((l) => JSON.parse(l).at.slice(0, 10)), ["2026-11-01", "2026-11-03", "2026-11-04"]);
  });
});
