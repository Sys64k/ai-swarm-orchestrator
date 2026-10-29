# Models

Which models the swarm uses: Claude through the Anthropic API, any OpenAI-compatible API (local models too), and a model per desk.

## Providers

A **provider** is where models come from. Add one with just its key (known providers know
their own address), or a local server's address; the Hub then lists the models it offers:

```bash
aso provider add anthropic                 # asks for the key (hidden)
aso provider add openai                    # also: openrouter, gemini, groq, mistral
aso provider add ollama --url http://avalon:11434/v1
aso provider add ollama-cloud              # Ollama's hosted models: its key, no address
aso provider add custom --name lab --url http://lab:8000/v1   # any OpenAI-compatible API
aso providers                              # each provider and how many models it lists
aso provider remove openai                 # forgets the key
```

- **In the console:** **Model providers** (on the home page, next to the worker machines) lists
  the providers and their prices, adds one (the key in a password field, sent once) and removes
  one. Over plain HTTP it warns that a typed key crosses the network unencrypted: use HTTPS
  (e.g. Tailscale) or `aso provider add` on the Hub machine.
- **Models are named `<provider>/<model>`** (`anthropic/claude-haiku-5-5`, `ollama/qwen3-coder:30b`,
  `openrouter/meta-llama/llama-3.3-70b`), wherever a model is chosen: `--model`, `--agent-model`,
  `aso desk`, the console. A name only one provider offers works on its own
  (`aso desk avalon#4 qwen3-coder:30b`); one several offer asks you to choose.
- **The lists come from the providers' own APIs** (Anthropic's `/v1/models`, the others'
  `/models`), cached for 5 minutes, so a new model shows up without an ASO update. If Anthropic
  can't be reached, the current Claude models are offered anyway.
- **A provider is added only if it works:** its model list is fetched first, so a wrong key or
  an unreachable server is refused with the reason, and nothing is saved.
- **Keys stay on the Hub**, in `<projects root>/.aso/providers.json` (owner-only), and the API
  never shows them. When asked, `aso provider add` reads the key at a hidden prompt (or from
  stdin when piped), so it doesn't land in your shell history. See
  [SECURITY.md](../SECURITY.md#the-credentials).
- **Prices:** Claude models are priced from the Hub's table; OpenRouter reports its own prices,
  which the Hub uses. For any other model, set one, so task budgets stop it too (otherwise it
  reads $0 and only the turn limit does):
  `aso price set openai/gpt-5 --input 1.25 --output 10 --cache-read 0.125` (USD per million
  tokens; `aso prices` lists them). **Give the cache-read price too:** agents re-send their
  conversation each turn and providers serve most of it from their cache, so most input
  tokens are cache reads (a Gemini task here read 18.6M cached tokens against 0.95M fresh).
  Without `--cache-read` they count at the input price, which can overstate the cost
  several times over and stop tasks at their budget early.
- **The Architect's model:** `--model <provider>/<model>`. Without it, the Hub uses Claude Opus
  when Anthropic is a provider; with no Anthropic provider, give `--model` (and restart the Hub
  after adding the provider it names).
- **Two ways of calling:** OpenAI itself through its **Responses API** (its newer models, such as
  `gpt-6.1-sol`, take tools with reasoning only there); every other provider but Anthropic
  through the OpenAI-style Chat Completions API, where only the address, key and model name
  differ. Nothing is stored at OpenAI (`store: false`).
- **Or put keys in the Hub's `.env`** (`~/.config/aso/.env`, read when the Hub starts):
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`,
  `MISTRAL_API_KEY` and `OLLAMA_API_KEY` (Ollama Cloud) each make that provider available, and `ASO_LLM_BASE_URL` adds one
  OpenAI-compatible server as `local`. A change there needs a Hub restart; one made with
  `aso provider add` doesn't. A provider added on the Hub takes over a `.env` one of the same
  name. Older model names (`claude-haiku-5-5`, `openai:qwen3-coder:30b`) keep working.
- **Ollama Cloud** (`ollama-cloud`, key from ollama.com/settings/keys) serves Ollama's hosted
  models (`ollama-cloud/<model>`, as `GET /api/models` lists them) at `https://ollama.com/v1`.
  It's a subscription with usage limits, not priced per token, so its models cost $0 in the
  track records and task budgets don't stop them unless you set a price (`aso price set`).
- **Gemini** names its models `models/<name>` (`gemini/models/gemini-3.8-flash`), and its list
  includes models it no longer serves to new keys; such a model fails on its first call with
  Google's explanation. `aso llm-check --model <spec>` tries one first.

## Connecting Claude

Agents call Claude through the **Hub only**, using the official Anthropic API.

1. **Get an API key.** Create an organization and key at [console.anthropic.com](https://console.anthropic.com).
   - **On a Claude Max or Team plan:** link that Console organization to your plan under
     **API credits**. The plan includes monthly API credits (e.g. $100/month on Max 5x)
     that cover this usage.
   - **When credits run out:** requests stop until next month, unless you buy credits or
     turn on auto-reload. Nothing is charged to your plan.
2. **Cap spending.** Give ASO its own workspace with a spend limit, and create the key there.
3. **Put the key in a `.env` file** on the Hub machine. This is the ASO folder's `.env` for a
   source checkout, or `~/.config/aso/.env` for any install:
   ```bash
   cp .env.example .env && chmod 600 .env   # then set ANTHROPIC_API_KEY=sk-ant-... in it
   ```
   The `aso` command loads it automatically.
   - **Not shared:** `.env` is git-ignored and excluded from the Docker build context.
   - **Overrides:** a variable already set in your shell takes precedence over the file.
   - **Other settings:** the file can also hold defaults for the other options
     (see `.env.example`).
4. **Verify the key:**
   ```bash
   aso llm-check            # one tiny request; prints the reply and its cost
   ```
5. **Start the Hub.** With `--docker`, the key is passed into the container through the
   environment rather than baked into the image.

Only the Hub needs the key. Workers never see it, and never contact Anthropic directly.

Your Claude subscription *login* (the one used by claude.ai and Claude Code) is not used.
Anthropic's terms reserve it for their own apps. Automating claude.ai through a browser is
prohibited outright.

**Defaults** (all configurable on `start-hub`):

| | Default | Flag |
|---|---|---|
| Model | `claude-opus-5-5` ($4 / $20 per million input/output tokens; cached input $0.20) | `--model` |
| Builder and QA agents' model | the same as `--model`; e.g. `claude-haiku-5-5` ($0.10 / $0.50, cached input $0.01) for small, clear tasks | `--agent-model` |
| Effort | `high` | `--effort low…max` |
| Spend cap per task (estimated) | $5 | `--task-budget` |
| Spend cap per planning round (estimated) | $3 | `--plan-budget` |
| Model turns per task attempt or planning round | 80 | `--max-turns` |
| Concurrent model requests | 2 | `--llm-concurrency` |

**Running out of credit doesn't fail work.** When the Anthropic account's credit runs out,
the Hub puts model calls on hold: agents and the Architect wait (their task says *waiting:
Anthropic credit balance is too low…*), `GET /api/llm` shows `paused`, and your phone gets a
notification. Once credits are added, the next call works and everything carries on, with a
second notification.

The dashboard and `GET /api/llm` show calls and estimated spend; each task shows its own
turns and cost. Estimates use the Hub's price table. Your Console billing is authoritative.

### Other models (OpenAI-compatible APIs)

Any model behind an OpenAI-compatible Chat Completions API works too: OpenAI, Gemini, Mistral,
Groq, OpenRouter, LiteLLM, or a local server such as Ollama, vLLM or LM Studio. The simplest is
to [add it as a provider](#providers). The older way, one server in `~/.config/aso/.env`, still
works; it becomes the provider `local`:

```bash
ASO_LLM_BASE_URL=http://avalon:11434/v1   # the API's root (Ollama's OpenAI endpoint here)
ASO_LLM_API_KEY=                          # if the provider needs one; local servers don't
ASO_LLM_VISION=                           # 1 if the model accepts images (QA screenshots)
```

```bash
aso llm-check --model local/qwen3-coder:30b   # a reply and a tool call: can it drive an agent?
aso hub-service install ... --agent-model local/qwen3-coder:30b   # builders and QA on it
```

- **Mix and match.** `--model` (the Architect, and agents without `--agent-model`) and
  `--agent-model` each take any provider's model. Planning is the hardest job: keeping the
  Architect on a strong model and running builders and QA on a cheaper or local one is a good
  start. With neither on a Claude model, the Hub needs no Anthropic key at all.
- **Tool calling is required.** Agents work only through tool calls. `aso llm-check` tries one,
  and a turn answering it; a model that fails either can't work as an agent. Small local models often call tools poorly over
  long tasks; QA, review and the turn limit keep their mistakes out of `main`, at the cost of
  time.
- **Ollama:** let the Hub reach it (`OLLAMA_HOST=0.0.0.0:11434` in its service) and give it room
  for the agents' instructions and files (`OLLAMA_CONTEXT_LENGTH=32768` or more): its default
  context is too small, and Ollama's OpenAI endpoint can't change it per request.
- **A model per desk:** see [A model per desk](#a-model-per-desk).
- **What's Claude-only:** effort levels, prompt caching control, extended thinking and fallbacks
  on refusal. Costs read $0 for models without a price in the Hub's table, so task budgets don't
  stop them; the turn limit does.

### A model per desk

Each desk (a job slot on a worker machine, `<host>#<slot>`, e.g. `avalon#1`) can use its own
model. Name the model as `aso models` lists it:

```bash
aso models                           # what there is, from every provider
aso desk avalon#4 qwen3-coder:30b    # one desk on the local model
aso desk canfod claude-haiku-5-5     # every desk of a connected machine
aso desk avalon#4 default            # back to the default (--agent-model)
aso desks                            # each desk's model, and how busy each model is
```

- **In the console:** a worker's page has a model picker under each desk, and one for all its
  desks, with the models grouped by provider.
- **What there is to choose:** every model your [providers](#providers) list. A name it doesn't
  know is refused with the closest matches.
- **Calls at once per model:** 1 for local models by default (a local GPU serves few requests
  in parallel; more would only queue or push the model out of GPU memory), `--llm-concurrency`
  for Claude; `--concurrency <n>` on `aso desk` sets it for that model. The Architect and desks
  without a model of their own share `--llm-concurrency`.
- **A model on another server:** add that server as a provider (`aso provider add ollama --name ollama-lab --url …`).
- **One model per round:** an agent keeps the model its desk had when its conversation started;
  a change applies from the next round. Each task's history says which model worked on it.
- **Stored** in `<projects root>/.aso/models.json` (no secrets: keys stay with the providers).

### The Architect's and the reviewer's model

Two more roles take a model the same way, while the Hub runs:

```bash
aso desk architect claude-sonnet-5-5   # who writes the plans
aso desk reviewer gpt-5                 # who judges work in the acceptance check
aso desk reviewer default               # back to the Architect's model
```

- **Defaults:** the Architect uses the Hub's `--model`; the reviewer uses the Architect's model.
- **The reviewer runs on every task** (the Architect only on plans), so a cheaper reviewer
  saves the most. The [track records](#track-records-how-each-model-has-done) show what each
  model approved, rejected or couldn't decide, and how many of its approvals were
  [overturned](#when-a-reviewers-met-proves-wrong) later, so you can tell whether it holds up.
- **A machine's own model can't take a role:** it serves only its own machine's jobs.
- **Checked before it takes the role:** the Hub makes one small call with a tool, and refuses a
  model that can't take it (with the provider's reason), instead of it failing every task.
- **If the reviewer's call fails anyway** (its provider is down, say), that check runs on the
  Architect's model, then `--model`, so tasks don't all end up waiting for a person.
- **In the console:** *Model providers* has a picker for each; `aso desks` and `GET /api/desks`
  show both. A change applies to the next plan or check. Escalation's ladder is separate: it
  starts at `--model` unless [changed](#change-it-while-the-hub-runs).
- **Stored** with the desks' models in `models.json`; `POST /api/models/roles`.

### Escalation

A task that keeps failing on a cheap model moves up to a stronger one, so the strong model's
cost is only paid when it's needed:

1. **The desk's model tries first.** It gets `--junior-tries` tries (default 2), counting the
   first attempt: with 2, the first attempt and one rework round.
2. **Then the task climbs the ladder** (`--escalate-to`, weakest first; default: the Architect's
   `--model`), one step per further try. The stronger model gets the same rework
   reasons (what QA or the acceptance check found), so it knows what the cheaper one missed.
   It runs on whichever desk is free: the model runs on the Hub, the desk only runs the tools.
3. **A model whose API refuses the task** (a bad request, a refused key, a model it no longer
   serves) is skipped for that task from then on: the attempt is requeued on another model (the
   default, else the ladder) instead of failing, without using a rework round. Only when no
   other model is left does the task fail as before.

```bash
aso hub-service install ... --agent-model claude-haiku-5-5 \
  --escalate-to anthropic/claude-sonnet-5-5,anthropic/claude-opus-5-5 --junior-tries 2
```

- **In the task's history:** each agent conversation names its model and why, e.g.
  `(claude-sonnet-5-5, escalated after 2 rework rounds)` or `(claude-haiku-5-5, the default;
  gemini/models/gemini-3.8-flash refused this task)`.
- **Running out of turns counts too:** an agent that uses all its turns (`--max-turns`) has its
  work saved on the branch, and its task goes on in a rework round from there instead of
  failing, so it escalates like work QA or the acceptance check sent back. **So does a full
  context window:** an answer stopped for length after under 1,000 tokens means the conversation
  fills the model's window (no output limit is that small), so the next round starts a fresh
  conversation from the saved work; for a local model, give it more room (Ollama's
  `OLLAMA_CONTEXT_LENGTH`). **So does giving up:**
  an agent that stops without finishing, saying why, hands the task on to a rework round with
  its explanation (track records count it under failed).
- **The rework limit stays** at 3 rework rounds, so a task gets at most 4 tries. With the
  defaults:

  | Try | When | Model |
  |---|---|---|
  | 1 | the first attempt | the desk's |
  | 2 | 1st rework (QA or the acceptance check rejected try 1) | the desk's |
  | 3 | 2nd rework | the ladder's first model |
  | 4 | 3rd rework | the ladder's next model (or the same, at its top) |

  Rejected after try 4, the task fails.
- **A person's retry** starts the task again on its desk's model and gives refused models
  another chance (a refusal may have been fixed since).
- **Off:** `--no-escalation` keeps every round on the desk's model.
- **A task with a model of its own** (`model` when it's submitted, `POST /api/tasks`) runs every
  round on that model, whatever its desk's model, the ladder or a trial: no escalation, and a
  refusal fails it instead of moving it on. That keeps its record that model's alone, for
  finding what a model can do (see [Task levels](#task-levels-how-hard-a-model-can-go)).

#### Change it while the Hub runs

The ladder and the tries before it can be changed without a restart, to any provider's models,
not only Claude's:

```bash
aso escalation                                                    # where failing tasks move now
aso escalation openai/gpt-6.1-sol,anthropic/claude-opus-5-5       # the ladder, weakest first
aso escalation --junior-tries 3                                   # tries on the desk's model first
aso escalation default --junior-tries default                     # back to the start settings
```

- **Applies from the next round:** a task already on a step keeps that model until its round ends.
- **Over the start settings:** what isn't changed comes from `--escalate-to` and `--junior-tries`.
  A ladder set here turns escalation on even if the Hub started with `--no-escalation`.
- **Refused like a role's model:** a model the Hub can't use or that can't take tools (the same
  small check), a machine's own model, or a model twice on the ladder. Give a ladder model a price (`aso price set`, see
  [cli.md](cli.md#aso-prices-aso-price-setremove)) so the task budget counts it.
- **In the console:** *Model providers* → *Failed tasks (escalation)*. `aso desks` and
  `GET /api/desks` show it (`escalation`, and `escalationSet` for what was changed).
- **Stored** in `models.json` with the desks' and roles' models; `POST /api/models/escalation`
  (`{ ladder?: [...] | "default", juniorTries?: n | "default" }`).

### Track records: how each model has done

The Hub records every job on a task: each build (the first try and every rework round) and
each QA run, with its machine, desk, **model**, model cost, and what came of it. From those it
answers which model to put where:

```bash
aso track-records                    # by model
aso track-records --by host          # by machine (with their QA runs for others)
aso track-records --by desk --project aso-ui --since 2026-11-01
aso track-records --by project --model gpt-6.1-terra   # one model's work, per project
aso track-records --by level --model qwen3-coder:30b   # one model's work, per task level
```

It prints, for example:

```
MODEL                    FINISHED  1ST TRY  TOOK OVER  BUILDS  QA PASSED  ACCEPTED  OUT OF TURNS  FAILED  COST   STARTED  PER TASK
models/gemini-3.8-flash  14        9        0          25      14/17      12/13     6             1       $3.10  17/18    $0.41
claude-opus-5-5          3         0        3          3       3/3        3/3       0             0       $2.70  -        -
```

- **Finished:** merged tasks whose last build that checked out was this model's (machine's, …).
  **1st try:** of those, merged after a single build. **Took over:** someone else had built on
  the task before; with escalation, that's the stronger model rescuing it.
- **QA passed, accepted:** the verdicts on its builds' work, as good out of all.
- **Quality notes:** what the acceptance check noted on its checked work (duplicated code, dead
  code, a misleading summary, weakened tests), as "3 in 5" checks; they don't block, they show
  which model passes cleanly. See [How a task flows](using-aso.md#how-a-task-flows).
- **Out of turns, failed:** builds whose agent ran out of room (its turns, or its model's context
  window) or gave up.
- **Cost:** its own builds' estimated model cost.
- **Started, per task: what a task really costs.** The tasks whose first build was this model's
  (machine's, …), finished out of those that ended, and what a finished one cost **all in**:
  every build on any model (so a stronger model's takeover counts against the model the task
  started on), the acceptance checks, an equal share of the plan it came from, and the cost of
  the tasks that failed. This is the number to compare when choosing a desk's model: a cheap
  model that keeps escalating to Opus is expensive here. Cancelled tasks don't count (a person
  stopped them); a model that only takes over starts nothing, so it shows `-`. The API also keeps
  `costPerFinishedUsd`, its own builds per task it finished.
- **Plans and acceptance checks** (by model and by project), in a second table: the plans each
  model made as the Architect (proposed, approved, rejected, how many asked questions first, and
  their cost), and the acceptance checks it made as the reviewer (met, overturned, unmet,
  undecided, cost).
- Also by **role** (frontend, backend, …) and **project**; `--role` and `--since` narrow it.

#### When a reviewer's "met" proves wrong

A reviewer that passes everything would look perfect by its met count alone, and cheap. So the
Hub keeps track of work the acceptance check passed that didn't hold up, and counts it against
the model that judged it (**overturned**):

- **A person asked for changes** on the task's pull request, on GitHub or in ASO.
- **A person closed the pull request** without merging. (Cancelling the task in ASO doesn't
  count: that's not a verdict on the work.)
- **The deploy of its merge failed** in the project's own command (it ran and exited non-zero).
  A deploy the Hub couldn't start, or stopped (a restart, a timeout), doesn't count.

Only a `met` verdict can be overturned, once, and only on projects with pull requests or a
deploy. Compare reviewers on overturned out of met: few overturns at a low cost is the one to
keep. Public stats share it per model (`checksOverturned`), and the README shows how much of each
reviewer's met held up.
- Jobs are recorded from when the Hub started recording them; older tasks don't count. The
  core console shows the same under *Track records*, filtered by project, model, role and period,
  and `GET /api/track-records` serves it. With a model filter, only that model's work counts: its
  builds, the tasks it started and finished, its plans and acceptance checks, but no QA runs,
  which have no model.

#### Task levels: how hard a model can go

A task can say how hard it is: `level`, 1 to 5, when it's submitted (`POST /api/tasks`). Track
records group by it (`--by level`, with `no level` for tasks without one) and filter by it
(`--level 3`); plans have no level, so a level filter leaves them out. With a model of the
task's own (see [Escalation](#escalation)), the same tasks at each level show how far a model
goes before it fails, e.g. a local model through Ollama:

| Level | A task like |
|---|---|
| 1 | one pure function, with its tests |
| 2 | a change to an existing function, its tests still passing |
| 3 | a small feature across two or three files |
| 4 | a UI component with its tests |
| 5 | a change across packages (API and UI together) |

#### Suggestions: the cheapest mix that holds up

`aso tune` (and *Suggestions* on the console's *Track records* page, `GET /api/model-suggestions`)
compares, for each role, the model it's on now with every model that has enough data, over the
last 30 days (`--since` for another period):

| Role | Enough data | Cost compared | Quality compared |
|---|---|---|---|
| Desks | 10 settled tasks started on it | all in, per finished task (*started*, above) | finished of those settled |
| Reviewer | 10 met verdicts | per check | met verdicts that held up (not [overturned](#when-a-reviewers-met-proves-wrong)) |
| Architect | 5 proposed plans | per plan | proposed plans approved |

- **Cheaper:** at least 15% cheaper, and at most a little worse (desks and Architect 10 points,
  the reviewer 5). The cheapest such model is suggested.
- **Better:** clearly better (twice that margin), even if it costs more.
- **Otherwise it says what's missing,** e.g. *"models/gemini-3.8-flash: 5 of 10 settled tasks
  needed to compare it"*, or that the model in use is the best with enough data.
- **Nothing changes by itself.** `aso tune` prints the `aso desk` commands that apply a
  suggestion (for desks, each connected machine); the console has a *Switch* button. A model no
  provider offers now can't be applied.
- **It needs data on more than one model** to compare: a model nobody has tried has none. A
  [trial](#trials-getting-data-on-another-model) gets it.

#### Trials: getting data on another model

A model on trial takes a share of a role's work, within a budget, until suggestions can compare
it:

```bash
aso challenger desks openai/gpt-6.1-terra --share 30   # 30% of new tasks start on it, up to $20
aso challenger reviewer anthropic/claude-sonnet-5-5 --share 20 --budget 10
aso challenger desks none                              # end the trial
```

- **Desks:** a task it takes *starts* on it instead of its desk's model and keeps it through its
  junior tries and retries; escalation applies as usual, so its all-in cost is measured fairly.
  Its history says `(…, a model on trial)`.
- **Reviewer:** a task it takes has its acceptance checks made by it first; if its call fails,
  the usual reviewer takes over.
- **Which work:** decided by a hash of the task id (salted by role, so the two trials take
  different tasks): the same task always gets the same answer.
- **Share and budget:** the share defaults to 10%, and the budget to $20 for the desks (it pays
  for whole tasks, about $1–2 each all in) and $5 for the reviewer (only checks). A trial needs 10
  samples, so at 10% about 100 tasks pass before it can be compared: a small swarm wants a larger
  share (up to 50%).
- **It ends by itself** once it has the data suggestions need (10 settled tasks it started, or
  10 met verdicts it gave) or has spent its budget; `aso desks` shows how it stands.
- **Checked like a role's model:** it must take tools, and can't be a machine's own model. Give
  it a price so its spending counts.
- **Not for the Architect:** plans are too few for a share of them to give data soon.
- **Several at once:** each `aso challenger` adds a member to the role's pool (together at most 90%
  of the work); `--end` ends one, `none` ends them all.
- **In the console:** *Model providers* → *Model pools*. `POST /api/models/challengers`; `GET
  /api/tuning` shows them all.

#### Model pools and auto-tuning: a mix that adjusts itself

A role's pool is its own model (the *base*) and the members on trial, each with a share of the
work. With auto-tuning on, the Hub runs the trials and moves the shares by itself:

```bash
aso pool                                                          # the pools, shares and latest changes
aso pool-try desks openai/gpt-6.1-terra,anthropic/claude-sonnet-5-5   # models to try, in order
aso pool-auto desks on                                            # let the Hub tune the desks' mix
```

- **Trying:** while fewer than two members are still gathering data and the pool has room, the
  next queued model starts on 20% of the work, with the role's default budget. One that can't be
  used (refused by the tool check) is skipped, and the log says why.
- **Rebalancing:** every 5 new samples in the role, the models with enough data (the base, and
  members the track records have 10 samples of) are compared by all-in cost per unit (a finished
  task, a check) among those whose quality is within the role's margin of the best. The cheapest
  of those grows by up to 15 points; the others good enough shrink toward 10%; a member clearly
  worse is dropped, and so is one that spent its budget before it had data.
- **A new base:** when a member comes to take more than the base, it becomes the role's own model
  (the desks that were on the old one switch; the reviewer role changes), and the old base stays
  in the pool as a member, so it keeps being measured.
- **Seen and stoppable:** each change is logged (`aso pool`, the console) and sent as a push
  notification; `aso pool-auto <role> off` stops it, and nothing changes until it's on. With it
  off, members are plain trials: they end at their data or budget.
- **Slow on purpose:** with tens of tasks a day, shares move in small steps, so one lucky or
  unlucky task can't swing the mix.

#### Sharing them publicly (a README)

`aso start-hub --public-stats models,costs` makes the Hub answer `GET /api/public-stats` for
anyone, on its own port and on the worker gateway (so through Tailscale Funnel too):

- **Always:** tasks merged, how many on the first try or taken over, plans proposed and
  approved.
- **`models`:** the same per model, with QA and acceptance rates and the acceptance checks it
  made (met, and how many of those were overturned); **`costs`:** model costs in total, per task, and per model (each model's cost per task is
  the all-in one, for tasks that started on it). `totals` shares neither.
- **Never** machines, desks, people, projects or task titles. A machine's own model is only
  "a machine's own model". `--public-stats-projects aso-ui` counts only those projects' work.
- **It does show when:** the oldest job counted and the time of the answer, so how active the
  swarm has been can be read from it.
- **One period for everything:** from the oldest recorded job. Plans made before job records
  began aren't counted, so the cost per task doesn't include plans whose tasks it doesn't count.

This repository's README shows them: `.github/workflows/swarm-stats.yml` runs
`scripts/readme-stats.mjs` once a day, which reads the address in the repository variable
`SWARM_STATS_URL` (e.g. `https://<hub>.ts.net:10000/api/public-stats`) and rewrites the section
between `<!-- swarm-stats:start -->` and `<!-- swarm-stats:end -->`, committing only when the
numbers changed. It also keeps each day's stats in `docs/stats/history.jsonl`, a JSON line per day
(the day's latest run), so a page can later chart how they changed. Any project can do the same
with those two files. A commit that changes only the README and `docs/` doesn't make the Hub update
itself.

### A machine's own model (volunteer GPUs)

A worker machine with its own model server (Ollama, vLLM, LM Studio) can serve the model calls
of **its own jobs**, so a volunteer contributes AI capacity, not only CPU, and those calls cost
the Hub nothing:

```bash
aso service install --join <code> --local-model http://localhost:11434/v1 \
  [--local-model-name qwen3-coder:30b] [--local-model-vision]
```

- **The Hub keeps the conversation** (prompts, tools, history, checks) and sends each finished
  request over the machine's own connection; the machine calls its server and answers. It works
  behind a home router and through the worker gateway: the Hub never connects to the machine.
- **The machine calls only its own server**, and only models it listed when it connected,
  whatever the Hub asks.
- **Its desks use that model by default** (`machine/<model>` in the task's history: "this
  machine's own model"); a desk you put on another model with `aso desk` keeps that one. To
  pick another of its own models: `aso desk avalon#2 machine/llama3` (refused unless that
  machine serves it).
- **Where to see it:** the console's page for that machine names its own models, and its desk
  pickers list them under "This machine's own (free)"; `aso desks` lists the machines that
  serve their own. A
  machine's model never serves other machines' jobs, and takes one call at a time.
- **Free for the Hub:** these calls count $0, also against the key's budget.
- **The safety nets stay:** QA on a trusted machine, the acceptance check, your review, and
  escalation to a stronger model if its work keeps coming back.