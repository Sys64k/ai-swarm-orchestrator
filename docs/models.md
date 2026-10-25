# Models

Which models the swarm uses: Claude through the Anthropic API, any OpenAI-compatible API (local models too), and a model per desk.

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
Groq, OpenRouter, LiteLLM, or a local server such as Ollama, vLLM or LM Studio. Name the model
with an `openai:` prefix and tell the Hub where the API is, in `~/.config/aso/.env`:

```bash
ASO_LLM_BASE_URL=http://avalon:11434/v1   # the API's root (Ollama's OpenAI endpoint here)
ASO_LLM_API_KEY=                          # if the provider needs one; local servers don't
ASO_LLM_VISION=                           # 1 if the model accepts images (QA screenshots)
```

```bash
aso llm-check --model openai:qwen3-coder:30b   # a reply and a tool call: can it drive an agent?
aso hub-service install ... --agent-model openai:qwen3-coder:30b   # builders and QA on it
```

- **Mix and match.** `--model` (the Architect, and agents without `--agent-model`) and
  `--agent-model` each take a Claude model or an `openai:` one. Planning is the hardest job:
  keeping the Architect on a strong model and running builders and QA on a cheaper or local one
  is a good start. With both on `openai:` models, the Hub needs no Anthropic key at all.
- **Tool calling is required.** Agents work only through tool calls. `aso llm-check` tries one;
  a model that fails it can't work as an agent. Small local models often call tools poorly over
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
aso models                           # what there is: Claude, and the local server's models
aso desk avalon#4 qwen3-coder:30b    # one desk on the local model
aso desk canfod claude-haiku-5-5     # every desk of a connected machine
aso desk avalon#4 default            # back to the default (--agent-model)
aso desks                            # each desk's model, and how busy each model is
```

- **In the console:** a worker's page has a model picker under each desk, and one for all its
  desks.
- **What there is to choose:** the Claude models when the Hub has `ANTHROPIC_API_KEY`, and
  whatever the OpenAI-compatible server at `ASO_LLM_BASE_URL` lists (Ollama, vLLM, LM Studio,
  OpenRouter, OpenAI). A name it doesn't know is refused with the closest matches.
- **Calls at once per model:** 1 for local models by default (a local GPU serves few requests
  in parallel; more would only queue or push the model out of GPU memory), `--llm-concurrency`
  for Claude; `--concurrency <n>` on `aso desk` sets it for that model. The Architect and desks
  without a model of their own share `--llm-concurrency`.
- **A model on another server:** `aso desk avalon#4 openai:llama3.3:70b --base-url http://other:11434/v1`.
- **One model per round:** an agent keeps the model its desk had when its conversation started;
  a change applies from the next round. Each task's history says which model worked on it.
- **Stored** in `<projects root>/.aso/models.json` (no secrets: keys come from the Hub's
  `ANTHROPIC_API_KEY` and `ASO_LLM_API_KEY`).
