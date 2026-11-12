# The local-model experiment

How simple does a task have to be before a free model running on our own GPU gets it right?
Run from 2026-10-29 to 2026-11-04 on the `aso-test` project, with five models on avalon's Ollama. This page
says why we ran it, how, what we found, and what we changed in the core because of it. The code the
models wrote is public in [aso-local-model-ladder](https://github.com/Sys64k/aso-local-model-ladder), without the agents' transcripts.

## Why

1. **To cut costs.** A local model costs nothing per token. If it can take part of the work,
   the swarm pays only for what needs a paid model.
2. **To make tasks easier for every model.** A task simple enough for a weak model to finish
   should also be faster and cheaper for a strong one: fewer wrong turns, fewer rework rounds,
   less to read. The weak model is the measuring stick. Where it fails shows where tasks are
   unclear, and fixing that helps Gemini and Opus too.

The first aim is measured below. The second isn't yet: see [What's still open](#whats-still-open).

## How

- **A ladder of five levels** of tasks, each a real change to `aso-test` (a Next.js reader app):

  | Level | A task like |
  |---|---|
  | 1 | one pure function, with its tests |
  | 2 | a change to an existing function, its tests still passing |
  | 3 | a small feature across two or three files |
  | 4 | a UI component with its tests |
  | 5 | a change across the API and the UI |

- **Each model got its own variant of each level**, the same size and in the same parts of the
  code, because every task merges and a second model can't redo the first one's work.
- **Every task was pinned to its model** (a task's own `model`, [#131](https://github.com/Sys64k/ai-swarm-orchestrator/pull/131)):
  no escalation to Opus, so a failure stays the model's. Each carried its `level`, so
  `aso track-records --by level --model <name>` shows the result.
- **QA and the acceptance check ran as usual**, and each task got up to 3 rework rounds.
- **One task at a time.** Four at once on one GPU made a three-line function take 48 minutes:
  Ollama answers one request at a time and keeps only one conversation's context loaded, so
  interleaved conversations are re-read from scratch on every call.

### Hardware

Every model ran on one machine, avalon:

| Part | What it is |
|---|---|
| GPU | NVIDIA GeForce RTX 5060 Ti, 16 GB |
| CPU | AMD Ryzen 7 5700X, 8 cores |
| RAM | 46 GB as Linux reports it |
| Ollama | Each model's default tag (below); 32,768 tokens of context per conversation in the first runs, 65,536 later |

| Model | Ollama tag | Parameters | Quantisation | Size | Fits in 16 GB |
|---|---|---|---|---|---|
| qwen3-coder | `qwen3-coder:30b` | 30.5B | Q4_K_M | 18 GB | No |
| glm-4.7-flash | `glm-4.7-flash` | 29.9B | Q4_K_M | 19 GB | No |
| devstral | `devstral:24b` | 23.6B | Q4_K_M | 14 GB | Yes |
| gpt-oss | `gpt-oss:20b` | 20.9B | MXFP4 | 13 GB | Yes |
| qwen2.5-coder | `qwen2.5-coder:14b` | 14.8B | Q4_K_M | 9 GB | Yes |

"Fits" is the model's weights alone; its context takes more memory on top. qwen3-coder and
glm-4.7-flash don't fit, so Ollama ran part of each on the CPU. That makes them slower, but not
worse: on a GPU with more memory the same weights should get the same things right, only faster.
We didn't measure tokens per second. The minutes on this page are whole tasks, QA and reviews
included.

## Each model in short

For a link to one model. The details are in [What we found](#what-we-found).

### qwen3-coder 30B

Passed 3 of 5 levels on its own and 4 of 5 with tests first. Good at wiring code across files,
weak on logic with edge cases. It now does everyday tasks on one of our desks.
[Details](#the-first-two-that-can).

### glm-4.7-flash 30B

Passed 3 of 5 levels on its own and all 5 with tests first, the only model to pass all five. Next
to qwen3-coder on the same tasks it's about even, since each run's level 5 tests differed. Same
weak spot: logic with edge cases, including UI state. [Details](#glm-47-flash).

### gpt-oss 20B

Passed 3 of 5 levels on its own. With tests first it ran two tasks and passed one; the UI task
stayed beyond it. It deleted existing tests to make the suite pass. [Details](#the-first-two-that-can).

### devstral 24B

Passed 0 of 5, in two runs. It makes a few tool calls, then only describes its next step, so it
can't drive an agent. [Details](#two-of-the-five-models-cant-drive-an-agent).

### qwen2.5-coder 14B

Passed 0 of 5. It writes tool calls as JSON in its text instead of making them.
[Details](#two-of-the-five-models-cant-drive-an-agent).

## What we found

### Two of the five models can't drive an agent

| Model | Result |
|---|---|
| `devstral:24b` | Makes a few tool calls, then narrates its plan ("I'll read the file…") and stops without calling another. Passes a one-call check (`aso llm-check`) but not a real conversation with a builder's full tool list. 0 of 5, twice. |
| `qwen2.5-coder:14b` | Writes tool calls as JSON in its text instead of calling the tool. Never made a call. 0 of 5. |

No task level matters for these: neither finishes even the simplest task. What devstral did write
is in [its attempts](https://github.com/Sys64k/aso-local-model-ladder/branches/all?query=attempt%2Fdevstral).

**devstral was run again** on 2026-11-04, on the ladder's standard tasks (project
`ladder-devstral-24b-retest`), because its first run may have been held back: it had 32,768 tokens
of context instead of 65,536, one round per task, and a Hub without the later fixes. All five still
failed, in 4 to 10 minutes each.

| Run | Rounds per task | Tool calls, all five levels | File writes |
|---|---|---|---|
| 2026-10-29 | 1 | 8 | 2 |
| 2026-11-04 | 4 | 29 | 3 |

That's about 1.5 calls per round in both runs, so neither the larger context nor the fixes changed
the behaviour. Every round ended the same way, with the model describing its next step and not
taking it. The tasks differed between the runs, and it's one run each.

### The first two that can

A third, glm-4.7-flash, came later and has [its own section](#glm-47-flash). Without tests first
([what was merged](https://github.com/Sys64k/aso-local-model-ladder/compare/base...run/first-runs), and the failed attempts of
[qwen3-coder](https://github.com/Sys64k/aso-local-model-ladder/branches/all?query=attempt%2Fqwen3-coder) and
[gpt-oss](https://github.com/Sys64k/aso-local-model-ladder/branches/all?query=attempt%2Fgpt-oss)):

| Level | qwen3-coder 30B | gpt-oss 20B |
|---|---|---|
| 1 | ✅ 1st try | ✅ 1st try |
| 2 | ❌ 4 tries | ✅ 1st try |
| 3 | ❌ 4 tries | ❌ gave up |
| 4 | ✅ 2nd try | ❌ gave up |
| 5 | ✅ 4th try | ✅ 2nd try |

All of it was free apart from the acceptance checks, a few cents per task.

**The level isn't what decides success.** qwen3-coder passed level 5 and failed level 3. What
it fails is **logic with edge cases**: merging by id under a limit, cutting text at a length.
Wiring code together across files it does fine.

**Deciding what "done" means is the weak spot, not writing code.** In every logic failure the
model's own tests and code disagreed, or it changed a test to fit its code. qwen3-coder wrote
a test allowing 61 characters where the limit was 60. gpt-oss deleted existing tests to make
the suite pass. When we gave qwen3-coder's failed level-2 task again with the exact tests in
it, it passed first time in 9 minutes. (That failure was ours: the criterion was vague, and the
reviewer read it more strictly than the project's own code did. glm-4.7-flash later failed the
same way, and [#145](https://github.com/Sys64k/ai-swarm-orchestrator/pull/145) rewrote the task;
see [glm-4.7-flash](#glm-47-flash).)

### With tests first

Opus wrote the tests, then the local model wrote the code ([Tests first](using-aso.md#tests-first)):

| Task | Model | Before | Tests first | Cost all in |
|---|---|---|---|---|
| Backup export/import (level 3) | qwen3-coder | ❌ 4 tries | ✅ 1st try, 12 min | $0.49 |
| Search documents (level 3) | gpt-oss | ❌ gave up | ✅ 2nd try, 9 min | $0.49 |
| Rename a document (level 4, UI) | gpt-oss | ❌ gave up | ❌ 3 rework rounds | $0.71 |
| Backup export/import (level 3) | glm-4.7-flash | ❌ 4 tries | ✅ 1st try, 14 min | $0.58 average |
| Text statistics (level 5) | glm-4.7-flash | ❌ 4 tries | ✅ 2 rework rounds, 17 min | $0.58 average |

Almost all of that cost is Opus writing the tests (about $0.48); the local model is free. For
scale, on 4 November the swarm's two busiest paid builders cost $0.62 (`gpt-6.1-terra`) and $1.48
(`gemini-3.8-flash`) per task all in. Those are other tasks, so this isn't yet a fair comparison,
and tests first isn't clearly cheaper than the cheaper of the two.

Tests first rescued all four logic tasks. The UI task across three files stayed beyond gpt-oss,
which is also why the Architect doesn't mark UI work tests first.

### glm-4.7-flash

Run on 2026-10-30 with the ladder script, the first model on the same tasks from the same code
(variant A from `9cac1e3`), without tests first ([the code](https://github.com/Sys64k/aso-local-model-ladder/compare/base...run/glm-4-7-flash)):

| Level | Task | Result | Minutes |
|---|---|---|---|
| 1 | Word count helper | ✅ 1st try | 7 |
| 2 | Tidy document titles on save | ✅ 2nd try (corrected task) | 8 |
| 3 | Backup export and import | ❌ 4 tries | 169 |
| 4 | Clear all recent documents | ✅ 3rd try | 23 |
| 5 | Text statistics before reading | ❌ 4 tries | 44 |

$0.12 in all, for acceptance checks.

- **Level 2 first failed on our old criterion**, like qwen3-coder's. With the task rewritten
  (#145) it passed on its 2nd try: the first copied `deriveTitle`'s cutting code, and the new
  "shared, not copied" criterion sent it back to make one helper.
- **Level 3** ran out of turns once, then changed the existing `lib/settings.ts` to make its own
  backup tests pass, breaking the settings tests. QA refused it each time.
- **Level 5** passed QA on every try and went from three unmet criteria to one, but never fixed
  the last: old numbers stay on screen for 300 ms after the text gets too short, because it
  cleared them inside the delayed call. It said it had moved the clearing out; it hadn't.
- It ran shell syntax through `run_command` (`npm test -- -t exportBackup 2>&1 | head -50`),
  which has no shell.

Same pattern as the others: fine at wiring and simple functions, lost on logic with edge cases,
here including UI state. It does less than qwen3-coder at the top (qwen3-coder passed level 5),
so it doesn't take qwen3-coder's desk.

With tests first (`--tests-first`, project `ladder-glm-4-7-flash-tf`, run 2026-10-30 and 31,
[the code](https://github.com/Sys64k/aso-local-model-ladder/compare/base...run/glm-4-7-flash-tests-first)):

| Level | Task | Result | Minutes |
|---|---|---|---|
| 1 | Word count helper | ✅ 1st try | 4 |
| 2 | Tidy document titles on save | ✅ 1 rework round | 7 |
| 3 | Backup export and import | ✅ 1st try | 14 |
| 4 | Clear all recent documents | ✅ 2 rework rounds | 132 |
| 5 | Text statistics before reading | ✅ 2 rework rounds | 17 |

All five passed, against three without tests first. $2.89 for the five tasks ($0.58 per finished
task), nearly all of it Opus writing the tests, plus $0.12 for acceptance checks.

- **Levels 4 and 5 were each cut off once by us**, not the model: avalon was shut down mid-run,
  and level 4 was cancelled once to let a Hub update in. Minutes count the run that finished.
- **Level 3**, its worst level before, passed first time: with the tests already written it had
  no reason to change `lib/settings.ts`.
- **Level 4** ran out of its 80 turns once, then failed QA because it hadn't added the
  `Recent documents` region the tests look for. It fixed that on the next round.
- **Level 5** passed QA every time, and the acceptance check sent it back twice on the criterion
  it never met before. The first time, an in-flight request could still bring back numbers for
  short text. The second time, the 20-character limit was measured on normalized text instead
  of pasted text. It fixed both: the tests didn't catch either, and the acceptance check did.
- Levels 4 and 5 merged with one criterion left unclear (not unmet), and with 3 and 1 quality
  notes. Worth reading before giving it real work.

Tests first takes glm-4.7-flash from three levels to five, though three of the five needed rework
rounds.

qwen3-coder on the same five tasks with tests first (project `ladder-qwen3-coder-30b-tf`, run
2026-11-01, [the code](https://github.com/Sys64k/aso-local-model-ladder/compare/base...run/qwen3-coder-tests-first)), next to glm-4.7-flash:

| Level | Task | qwen3-coder | glm-4.7-flash |
|---|---|---|---|
| 1 | Word count helper | ✅ 1st try, 3 min | ✅ 1st try, 4 min |
| 2 | Tidy document titles on save | ✅ 1 rework round, 7 min | ✅ 1 rework round, 7 min |
| 3 | Backup export and import | ✅ 2 rework rounds, 11 min | ✅ 1st try, 14 min |
| 4 | Clear all recent documents | ✅ 1st try, 9 min | ✅ 2 rework rounds, 132 min |
| 5 | Text statistics before reading | ❌ 3 rework rounds, 109 min | ✅ 2 rework rounds, 17 min |

$2.49 for the five tasks, most of it Opus writing the tests.

- **Level 2** copied `deriveTitle`'s cutting code into a new helper; the acceptance check sent it
  back to share it, as it did glm.
- **Level 3** merged imported documents by id but kept duplicate ids from the backup itself;
  the acceptance check caught it twice before it used the merged map.
- **Level 4** was much faster than glm's: first try in 9 minutes, against glm's 132.
- **Level 5 failed on the tests, not only the model.** Opus's panel tests read the panel's whole
  text, pasted text included, and their pattern refuses a number straight after a `.`. The
  pasted sample ends in `.`, so the `123 words` layout the tests' own notes allow could never
  pass: `friend.123 words`. Only a label first (`Words: 123`) or a space before the numbers works.
  Opus writes new tests for every run, and glm's didn't have this trap (they matched
  `\b123\s+words\b` in the panel's own element). qwen3-coder never worked it out, and it said
  all tests passed while its own last run showed 4 failing. This is the first failure where tests
  first was the cause. The product owner found it on its own and proposed a corrected retry.
- **The corrected retry got past the tests but still failed** (accepted in the console, 41
  min, outside the table). With labels first, `npm test` passed, and the acceptance check
  found one real bug: shortening the text below 20 characters didn't make a running stats
  request stale, so its answer could bring the numbers back. The reviewer named it in three
  rounds; qwen3-coder read it each time as the out-of-order case, whose test already passed,
  and one round pushed the same commit unchanged. The product owner said "model" this time
  and proposed nothing: a plain retry would fail the same way, and the fix is one line.

The two are about even. Both passed levels 1 to 4, on the first try or with rework. glm also
passed level 5, but each run's level 5 tests were different, so level 5 doesn't separate them.
qwen3-coder was quicker at level 4, glm at level 3. One run each is too few to call.

### Many failures were ours

Weak models hit rough edges that strong ones step around. Each of these looked like the model
failing until we read the transcripts:

- **Empty turns.** gpt-oss sometimes answers with reasoning only. We sent that turn back as
  `content: null`, which Ollama refuses, failing the task.
- **A full context window** reported as "cut off at the output limit (17 tokens)" and retried in
  the same conversation, which can't help.
- **`finish` refused an empty screenshots list.** gpt-oss sent `"screenshots": []` on every
  finish, was refused 16 times in one run, and gave up "unable to format the finish command".
- **Every give-up was taken as disputing the tests**, so the one dispute went on "couldn't
  finish in time", and Opus rewrote tests that were fine.
- **A disputed test writer's push was refused** for the builder's code already on the branch.
- **An agent could change npm scripts on main.** gpt-oss changed `test` from `vitest run` to
  `node --test`, breaking QA for every task until we put it back.

## What we changed

| PR | Change | Because |
|---|---|---|
| [#131](https://github.com/Sys64k/ai-swarm-orchestrator/pull/131) | Task `level`; a task's own `model` | To run the experiment and keep each result one model's |
| [#133](https://github.com/Sys64k/ai-swarm-orchestrator/pull/133) | Empty turns left out; an empty reply asked again | gpt-oss's reasoning-only turns failed tasks |
| [#134](https://github.com/Sys64k/ai-swarm-orchestrator/pull/134) | A give-up is a rework round | gpt-oss gave up after 3 minutes and got no second try |
| [#135](https://github.com/Sys64k/ai-swarm-orchestrator/pull/135) | Quality notes; missing tests are unmet | qwen3-coder copied code and said it reused it; gpt-oss merged without the tests asked for |
| [#136](https://github.com/Sys64k/ai-swarm-orchestrator/pull/136), [#137](https://github.com/Sys64k/ai-swarm-orchestrator/pull/137) | Tests first, with Opus writing the tests; the Architect marks edge-case logic and names code to reuse | Deciding what "done" means was the weak spot |
| [#138](https://github.com/Sys64k/ai-swarm-orchestrator/pull/138) | A disputed writer works on the builder's code; a full context window named and given a fresh conversation | Both seen in the tests-first trial |
| [#139](https://github.com/Sys64k/ai-swarm-orchestrator/pull/139) | `dispute_tests`: only it sends the tests back | Give-ups were taken as disputes |
| [#140](https://github.com/Sys64k/ai-swarm-orchestrator/pull/140) | `finish` takes an empty screenshots list as none | gpt-oss's 16 refused finishes |
| [#141](https://github.com/Sys64k/ai-swarm-orchestrator/pull/141) | Agents may add npm scripts, not change them | gpt-oss broke `test` on main |
| [#143](https://github.com/Sys64k/ai-swarm-orchestrator/pull/143)–[#145](https://github.com/Sys64k/ai-swarm-orchestrator/pull/145) | The ladder script; level 2 says the title convention it's judged by | So the next models compare on the same tasks; two models failed our vague level 2 |
| [#148](https://github.com/Sys64k/ai-swarm-orchestrator/pull/148) | Weakened existing tests send the work back | gpt-oss deleted tests to pass; a later builder changed a test to fit its code, and only a non-blocking note saw it |
| [#152](https://github.com/Sys64k/ai-swarm-orchestrator/pull/152) | `run_command` refuses shell syntax, naming the command to run instead | glm-4.7-flash piped and redirected (`2>&1 \| head -50`) in a tool with no shell |

Outside the core, Ollama on avalon now gives each conversation 65,536 tokens of context
instead of 32,768, and qwen3-coder works desk avalon#4 on everyday tasks. Escalation still
moves a task it fails twice to Opus.

## Trying another model

1. **Make it available.** Pull it on avalon (`ollama pull <model>`), or add its provider, and
   check that it can call a tool: `aso llm-check --model local/<model>`. Passing that isn't
   proof (devstral passed it): the ladder is.
2. **Run the ladder** on the Hub's machine, from the core repo after `npm run build`:

   ```bash
   node scripts/local-model-ladder.mjs local/<model>                 # as it is
   node scripts/local-model-ladder.mjs local/<model> --tests-first   # Opus writes the tests first
   ```

   Each run gets a fresh project (`ladder-<model>`) holding aso-test as it was before the first
   ladder (commit `9cac1e3`), so every model does the same five tasks (variant A) from the same
   code. The script submits them one at a time, pinned to the model, and prints a table of
   results. Variants B–D are the other tasks the first four models ran (`--variant`). To run it on
   your own Hub, clone [aso-local-model-ladder](https://github.com/Sys64k/aso-local-model-ladder) into your projects folder as `aso-test`.
3. **Add the results here**, next to the earlier ones, with anything it taught us, and keep
   [What's still open](#whats-still-open) current.

The first four models ran on one shared project, each on its own variant, so their numbers
above compare only roughly. From here on, models compare on the same tasks.

## What's still open

- **Do these changes help the strong models?** The second aim needs measuring: Gemini's and
  Opus's tests-first tasks against their ordinary ones, on tries, turns and cost per finished
  task. Track records can show it once there are enough of each.
- **Is qwen3-coder worth its desk?** Its everyday record against Gemini's (finished, first
  try, cost all in) will show whether its share of the work should grow or end.
- **Tests written first can be wrong.** A test that refuses what its own notes allow can't be
  fixed by the builder, which may not change it. A writer that runs its tests against a
  sketch of the feature, or a dispute the product owner can settle, would catch that.
- **devstral** might drive the agent with a firmer reminder to call a tool, or another prompt
  template; not tried. More context didn't help.
- **Ollama Cloud's larger models** (added as a provider in [#132](https://github.com/Sys64k/ai-swarm-orchestrator/pull/132))
  would show how much model size moves the line between pass and fail.
