# The local-model experiment

How simple does a task have to be before a free model running on our own GPU gets it right?
Run on 2026-10-29 on the `aso-test` project, with four models on avalon's Ollama. This page
says why we ran it, how, what we found, and what we changed in the core because of it.

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

## What we found

### Two of the four models can't drive an agent

| Model | Result |
|---|---|
| `devstral:24b` | Narrates its plan ("I'll read the file…") instead of calling a tool. Passes a one-call check (`aso llm-check`) but not a real conversation with twenty tools. 0 of 5. |
| `qwen2.5-coder:14b` | Writes tool calls as JSON in its text instead of calling the tool. 0 of 5. |

No task level matters for these: they never get as far as code.

### The two that can

Without tests first:

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
it, it passed first time in 9 minutes. (That failure was partly ours: the criterion was vague,
and the reviewer read it more strictly than the project's own code did.)

### With tests first

Opus wrote the tests, then the local model wrote the code ([Tests first](using-aso.md#tests-first)):

| Task | Model | Before | Tests first | Cost all in |
|---|---|---|---|---|
| Backup export/import (level 3) | qwen3-coder | ❌ 4 tries | ✅ 1st try, 12 min | $0.49 |
| Search documents (level 3) | gpt-oss | ❌ gave up | ✅ 2nd try, 9 min | $0.49 |
| Rename a document (level 4, UI) | gpt-oss | ❌ gave up | ❌ 3 rework rounds | $0.71 |

Almost all of that cost is Opus writing the tests (about $0.48); the local model is free. For
scale, the swarm's Gemini tasks cost $1.88 each all in, but those are other tasks, so this isn't
yet a fair comparison.

Tests first rescued both logic tasks. The UI task across three files stayed beyond gpt-oss,
which is also why the Architect doesn't mark UI work tests first.

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

Outside the core, Ollama on avalon now gives each conversation 65,536 tokens of context
instead of 32,768, and qwen3-coder works desk avalon#4 on everyday tasks. Escalation still
moves a task it fails twice to Opus.

## What's still open

- **Do these changes help the strong models?** The second aim needs measuring: Gemini's and
  Opus's tests-first tasks against their ordinary ones, on tries, turns and cost per finished
  task. Track records can show it once there are enough of each.
- **Is qwen3-coder worth its desk?** Its everyday record against Gemini's (finished, first
  try, cost all in) will show whether its share of the work should grow or end.
- **devstral** might drive the agent with a firmer reminder to call a tool; not tried.
- **Ollama Cloud's larger models** (added as a provider in [#132](https://github.com/Sys64k/ai-swarm-orchestrator/pull/132))
  would show how much model size moves the line between pass and fail.
