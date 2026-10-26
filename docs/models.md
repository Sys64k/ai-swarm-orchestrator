# Models

Which models the swarm uses: Claude through the Anthropic API, any OpenAI-compatible API (local models too), and a model per desk.

## Providers

A **provider** is where models come from. Add one with just its key (known providers know
their own address), or a local server's address; the Hub then lists the models it offers:

```bash
aso provider add anthropic                 # asks for the key (hidden)
aso provider add openai                    # also: openrouter, gemini, groq, mistral
aso provider add ollama --url http://avalon:11434/v1
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
  `aso price set openai/gpt-5 --input 1.25 --output 10` (USD per million tokens; `aso prices`
  lists them).
- **The Architect's model:** `--model <provider>/<model>`. Without it, the Hub uses Claude Opus
  when Anthropic is a provider; with no Anthropic provider, give `--model` (and restart the Hub
  after adding the provider it names).
- **One way of calling for all:** every provider but Anthropic is called through the same
  OpenAI-style Chat Completions API; only the address, key and model name differ. For OpenAI
  the answer limit is sent as `max_completion_tokens` (its reasoning models refuse
  `max_tokens`). Models only on OpenAI's newer Responses API aren't supported.
- **Or put keys in the Hub's `.env`** (`~/.config/aso/.env`, read when the Hub starts):
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`
  and `MISTRAL_API_KEY` each make that provider available, and `ASO_LLM_BASE_URL` adds one
  OpenAI-compatible server as `local`. A change there needs a Hub restart; one made with
  `aso provider add` doesn't. A provider added on the Hub takes over a `.env` one of the same
  name. Older model names (`claude-haiku-5-5`, `openai:qwen3-coder:30b`) keep working.
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
