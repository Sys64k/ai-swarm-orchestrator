# Skynet: AI Swarm Orchestrator (ASO)

**Skynet** is the project's nickname; the code, the `aso` command and its files keep the name
ASO. ASO coordinates a swarm of AI coding agents across the Linux machines on your local network.
A central **Hub** splits project work into tasks and hands each one to the **Worker Node** best
suited to it. Workers edit, build and test code on their own hardware and deliver results through
Git. LLM access goes only through the Hub, so workers never hold API credentials.

```
        ┌──────────── Hub machine (Ubuntu server) ─────────────┐
        │  ┌──── Docker container ────┐   tmux: Architect      │
        │  │ API · WebSocket · Git    │                        │
        │  │ Dashboard · LLM gateway  │◄── target project repo │
        │  └──────────▲───────────────┘    (mounted)           │
        └─────────────┼────────────────────────────────────────┘
                      │ WebSocket + Git over HTTP, port 7420
         ┌────────────┼─────────────┬──────────────┐
   ┌─────┴──────┐ ┌───┴────────┐ ┌──┴─────────┐
   │ Worker     │ │ Worker     │ │ Worker     │   only the `aso` CLI,
   │ Pop!_OS    │ │ CachyOS    │ │ Ubuntu     │   running natively
   └────────────┘ └────────────┘ └────────────┘
```

For the design, diagrams and protocol reference, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, `aso` CLI, Hub/Worker/Architect processes, Zod WebSocket protocol, Docker image for the Hub | ✅ Done |
| 2 | Hardware profiling, node registry, hardware-aware task routing | ✅ Done |
| 3 | Git flow: Hub-hosted repo over HTTP, task branches, push verification, QA pipeline, rework loop, auto-merge to `main` | ✅ Done |
| 4 | Dependency requests: the Hub adds npm packages on `main`, workers rebase and `npm ci` | ✅ Done |
| 5 | LLM gateway on the Hub (Anthropic API), coding agent loop on workers, per-task cost tracking | ✅ Done |
| 6 | Architect planning (`aso plan`), task dependencies, role prompts and write scopes | ✅ Done |
| 7 | Token authentication, push to `origin` after merges, packaged CLI served by the Hub, `aso update` | ✅ Done |
| 8 | Hub state saved to disk: tasks, plans and agent conversations survive a Hub restart | ✅ Done |
| 9 | Job sandbox: every job command runs in a throwaway Docker container; task transcripts, cancel and retry | ✅ Done |
| 10 | Mobile-first console with one-time sign-in links, several projects per Hub, push notifications to phones | ✅ Done |
| 11 | A conversation with the Architect before a plan is approved; the Architect gives each task its role | ✅ Done |
| 12 | Fleet: workers and the Hub as systemd services, job slots per machine, QA on another machine, drain and restart from the console, automatic worker updates | ✅ Done |
| 13 | Review: a GitHub pull request per task, reviewed and merged (or sent back) in the console with its CI checks; the Hub API described as OpenAPI 3.1 | ✅ Done |
| 14 | Agents: a cheaper model for builders and QA, plan budgets, conflict resolution with `main`, unfinished work kept at the turn limit, a hold when the Anthropic credit runs out, QA screenshots for the reviewer | ✅ Done |
| 15 | Operations: deploy after each merge, catch up with merges made on GitHub, the Hub updating itself from its repository's `main`, offline alerts for workers, deploys and updates in `aso status` | ✅ Done |
| 16 | Workers anywhere: a revocable key per worker machine, and LAN discovery so workers find the Hub without its address | ✅ Done |

The whole loop runs end to end: you describe a requirement, the Architect plans it with you,
and each task is routed to the best free machine. An agent there explores and edits the code
and verifies its work. The Hub checks the push, QA tests it (on another machine when one is
free), and the agent reworks it if needed. You review the pull request, from your phone if you
like, and a project with a deploy command is deployed after the merge. Agents need an Anthropic API key on the Hub; see
[Connecting Claude](#connecting-claude).

## What runs where

| Machine | Runs | Needs |
|---|---|---|
| Hub | Hub API, WebSocket, Git endpoint and dashboard (in Docker, or directly), plus the Architect in tmux | Docker with Compose v2 (or Node.js ≥ 20 + git), tmux |
| Each worker | `aso start-worker` on the machine itself; each job's commands in throwaway Docker containers | Node.js ≥ 20, git and Docker (the worker's user in the `docker` group) |

There are two layers on a worker:

- **The worker program runs on the machine itself**, not in a container. It needs the real
  machine: to measure the hardware (which decides its desks), to use the machine's Docker,
  and to update and restart itself.
- **Everything a job runs goes into a throwaway container**: the agent's commands, `npm ci`
  with its install scripts, builds and QA tests. That container sees only the task's
  checkout, so an agent can't reach the rest of the machine. See
  [SECURITY.md](SECURITY.md#agents-and-their-code); `--sandbox none` turns this off.

Workers need no LLM credentials and no manual copy of the project. They clone it from the Hub
automatically into `~/.aso/work/project`. Every model call goes through the Hub, which holds
the only API key.

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

## Installation

### Hub machine

Install from source (this repository) and build the distributable package once:

```bash
git clone git@github.com:vaisajuh/ai-swarm-orchestrator.git aso && cd aso
npm install
npm run package            # builds everything + release/aso.tgz (the package workers install)
npm link -w @aso/cli       # puts `aso` on your PATH (or use: npm run aso -- <command>)
```

Start the Hub, in Docker (recommended) or directly:

```bash
aso start-hub --docker    # first run builds the image (a few minutes)
aso start-hub             # without Docker
```

The Hub works on **projects** in `~/aso-projects` (change it with `--root`). Each git
repository directly inside that folder is a project, named after its folder. Create new
projects from the console or with `POST /api/projects`, optionally connected to a GitHub
repository. To bring in a repository from elsewhere, move or clone it into the folder; it
needs at least one commit on `main`. See
[Projects](#projects).

The first start generates the **ASO token** (`~/.config/aso/token`, readable only by you).
Every worker, the CLI and the dashboard need it. Show it with:

```bash
aso token
```

You get:

- **Console:** `http://<hub-ip>:7421`, built for phones first. Sign in once with the token
  and the browser remembers it. See [The console](#the-console).
- **Hub endpoints:** the API, WebSocket and Git endpoint at `<hub-ip>:7420`.
- **Architect:** runs in tmux (`tmux attach -t aso-architect`).
- **Container ownership:** in Docker the container runs as your user ID, so files the Hub
  writes into your project keep your ownership.

#### Keep the Hub running (systemd)

`aso start-hub` runs only as long as its terminal. On Linux, install it as a systemd user
service instead, with the same options:

```bash
aso hub-service install --docker   # same options as start-hub
aso hub-service status
aso hub-service logs -f            # the Hub's, the console's and the Architect's output
aso hub-service restart            # after rebuilding or updating aso
aso hub-service uninstall
```

- **Starts at boot, restarts on failure.** `~/.config/systemd/user/aso-hub.service` runs the
  `aso` you installed it with, using your current `PATH`, and restarts 10 s after any exit.
  Lingering is turned on as for the worker service, so it runs without a login.
- **Options:** the unit keeps the options you typed, plus the projects folder as an absolute
  path. Everything else is read again at each start: the token file, `ANTHROPIC_API_KEY` and
  `ASO_*` settings from `~/.config/aso/.env` (or the checkout's `.env`). A key that is only
  exported in your shell does not reach the service; the install warns about that.
- **The Architect runs as a child process** of the service instead of in tmux, so its output
  is in `aso hub-service logs`. It is started again 10 s after it exits.
- **One Hub per port.** The install refuses while another Hub answers on the port: stop that
  one first.

### Worker machines

Workers install the package the Hub serves. No clone, build or npm registry access is needed.
Each machine joins with **its own worker key**: on the Hub machine, `aso worker-key new` (or
**Worker machines → Add a machine** in the console) prints a one-time code and what to run:

```bash
curl -fo /tmp/aso.tgz http://192.168.1.10:7420/dist/aso.tgz && npm install -g /tmp/aso.tgz
aso service install --join <code>
```

#### Finding the Hub on the LAN

On the Hub's network a worker needs no address. Without `--hub`, it broadcasts a question on
UDP port 7419, and the Hub's machine answers with the Hub's address. The worker asks again
whenever it can't reach the Hub, so it follows the Hub to a new address (a new DHCP lease, say)
within seconds, and the Hub's machine needs no fixed IP.

- **Only the Hub that knows this machine's key, or the join code, can answer.** The answer
  carries a proof made with that credential and the addresses it comes from, and the worker
  connects only to an answer that checks out. A machine on the LAN pretending to be the Hub
  never gets the key. A Hub that doesn't know the credential stays silent.
- **`aso find-hub`** prints where the Hub is (`--join <code>` before the machine has a key).
- **An address you give wins.** With `--hub`, the worker uses only that address, as before.
  Workers on another network (Tailscale, `wss://`) need it: broadcasts don't cross networks.
- **What can stop it:** a firewall on the Hub's machine that drops UDP 7419, Wi-Fi client
  isolation, or a VPN on the worker. With NordVPN connected, run
  `nordvpn set lan-discovery on`, or give `--hub`.
- **The Hub side** answers from `aso start-hub` on the host, outside any container, because
  broadcasts don't reach a container on Docker's bridge network. `--discovery-port` changes the
  port, and `--no-discovery` turns it off.

- **A worker key only does worker work:** the worker connection, and the projects' Git (pushes
  to task branches only). It can't plan, approve, merge, deploy or read the API, so a machine
  that is lost or compromised doesn't hand over the Hub.
- **One key per machine, revocable:** `aso worker-keys` lists them (connected, last seen),
  `aso worker-key revoke <id>` (or **Revoke** in the console) disconnects that machine at once
  and keeps it out. The Hub stores only a hash of each key; the machine keeps its key in
  `~/.config/aso/worker-key` (mode 600).
- **The join code** works once, for 30 minutes. `--name` labels the key (default: the
  machine's hostname).
- Workers that use the Hub's main token (`ASO_TOKEN`) keep working; `aso status` and the console
  say which workers use it, so you can move them to keys.

#### Workers anywhere

A worker connects out to the Hub, so it needs no open port, wherever it is. What matters is how
its traffic gets there:

- **Tailscale (recommended for your own machines):** put the Hub machine and the worker in the
  same tailnet and use the Hub's tailnet name: `aso service install --hub agent007 --join
  <code>`. LAN discovery doesn't reach across Tailscale, so `--hub` is needed here. WireGuard encrypts everything end to end, and nothing of the Hub faces the internet.
- **TLS:** with a `wss://` address (a reverse proxy or tunnel with HTTPS in front of the Hub's
  port), the worker connection, Git and updates all use TLS.
- **Plain `ws://` over the internet is refused.** If the Hub's address resolves to a public IP
  and the address isn't `wss://`, the worker stops with the reason, because the key, the code and
  every job would cross the internet unencrypted. `--allow-insecure` overrides that.
- Model calls go through the Hub: workers never hold the Anthropic key.

Workers need **Docker**, usable by the worker's user (in the `docker` group). Every command a
job runs goes into a throwaway container: agent commands, `npm ci` with its install scripts,
and QA tests. That container sees only the task checkout. The first start builds the sandbox
image, which is about 2 GB: Node plus the libraries headless Chromium needs. See
[SECURITY.md](SECURITY.md#agents-and-their-code). Without Docker, `--sandbox none` runs those commands
directly on the machine instead.

#### Keep a worker running (systemd)

On Linux, install the worker as a systemd user service instead of starting it by hand. It
starts at boot, restarts if it crashes, and `aso update` restarts it on the new version:

```bash
aso service install   # same options as start-worker; finds the Hub on the LAN without --hub
aso service status
aso service logs -f
aso service uninstall
```

- **Where it lives.** `aso service install` writes `~/.config/systemd/user/aso-worker.service`.
  The unit runs the `aso` you ran it with, using your current `PATH` (so it finds Docker and
  git like your shell does), and restarts 10 s after any exit.
- **The token stays out of the unit file.** If the token comes from `~/.config/aso/.env` or
  the token file, the worker reads it there as usual. One passed with `--token` or only set in
  your shell is written to `~/.config/aso/worker.env` (mode 0600), which only the service
  reads.
- **Running without a login.** It enables lingering (`loginctl enable-linger`), so the worker
  runs at boot without you logging in and keeps running after you log out. If your system
  needs root for that, it prints the `sudo` command to run once.
- **To change options,** run `aso service install` again with the new ones.
- **One worker per work directory.** A worker locks its work directory (`worker.lock`), so a
  second `aso start-worker` on the same machine refuses to start while the service runs, and
  says which pid holds it. Stop the other one, or give the second worker its own `--work-dir`.
  A lock left by a crashed worker, or from before a reboot, is taken over automatically.

### Updating

Run `aso update` on any machine:

- **Installed packages:** fetches the Hub's package if its version differs, verifies its
  SHA-256, and installs it.
- **Source checkouts:** `git pull`, `npm ci` and a rebuild.

To roll out a new version, update the Hub machine, run `npm run package` there, and restart
the Hub (`aso hub-service restart` for the service; `aso update` on a Hub installed from the
package restarts the service itself). Workers then update themselves (below); run `aso update --hub <hub-ip>` on the
others. A worker installed with `aso service install` is restarted on the new version
automatically; restart others yourself.

Workers and the Architect report the build they run (`0.1.0+<commit>`; a source checkout
reports its commit, with `-dirty` for uncommitted changes). When it differs from the package
the Hub serves, the console marks the worker **Update**.

#### Automatic worker updates

A worker installed from the Hub's package and run by `aso service install` updates itself.
When it connects on another build than the one the Hub serves, the Hub gives it no new jobs,
lets its current ones finish, and then tells it to update. The worker downloads the Hub's
package, checks its SHA-256, installs it, and exits; systemd starts it on the new build a few
seconds later. The console shows **Update after job** or **Updating** meanwhile, and
**Cancel update** stops one that is still waiting for a job.

- **A failed install** (npm error, checksum mismatch) leaves the worker on its old build,
  taking jobs again. The console shows the error, and the Hub does not try that build on that
  machine again; run `aso update` there.
- **A worker that comes back on its old build** after two updates is left alone the same way.
- **Not updated automatically:** source checkouts (they follow their git remote, not the Hub)
  and workers started by hand. The console says to run `aso update` on them.
- **To turn it off,** set `ASO_AUTO_UPDATE=0` for the Hub.

#### Automatic Hub updates

A Hub installed with `aso hub-service install --update-from <git-url>` follows that
repository's `main` itself:

1. **Every 5 minutes** it asks the repository for `main`, with the Hub's own git setup (SSH
   agent, keys, credential helpers). A newer commit is checked out in its own clone
   (`~/.local/share/aso/hub/build/src`), installed with `npm ci`, tested with `npm test` and
   packaged. Those three get none of the Hub's variables (tokens, API key) and a home folder of
   their own, but they run as you: this is not a sandbox, so merge into the followed branch only
   what you would run on the Hub machine.
2. **It installs the package beside the running version** (`~/.local/share/aso/hub/versions/`).
   The service runs whichever version `~/.local/share/aso/hub/current` points at.
3. **It waits until a restart interrupts nothing:** no task assigned, at work, in QA or being
   merged, no deploy running and no plan being made. If `main` moved meanwhile, it starts over
   with the newer commit.
4. **The running version arms a watchdog** (a systemd timer outside the Hub service), points
   `current` at the new version, and restarts the service.
5. **The new version confirms itself** once it has answered as itself for a minute. If it
   hasn't within 15 minutes (it crashed, hung, or never started), the watchdog points `current`
   back at the previous version and restarts. Every start of the service first runs the same
   check with the previous version, so a reboot inside those 15 minutes rolls back too. That commit is never tried again; one whose build
   or tests failed is tried 3 times. The next commit on `main` is tried as usual.
6. **You get a notification** when the Hub has updated, or when an update failed, and
   `GET /api/hub/update` says where it stands. The workers then update from the new Hub as usual.

Set it up once, from a checkout of the version to start from:

```bash
npm run package                                    # the package the service will run
cp .env ~/.config/aso/.env && chmod 600 ~/.config/aso/.env   # the package reads settings from there
aso hub-service install --docker --update-from https://github.com/<you>/ai-swarm-orchestrator.git
```

The install puts the package in `~/.local/share/aso/hub/versions/` and points the service at
it, so the Hub no longer runs from the checkout. A source checkout or a Hub started by hand never
updates itself: both warn and ignore the option.

#### Projects that keep a copy of the Hub API

A project that builds on the Hub's API, such as a console of its own, can keep a copy of the
API description in `docs/openapi.json`, for generating its types. When the Hub starts on a
version whose API differs from that copy, it queues a task in the project:

- **The task's branch already has the new copy** as its first commit, by the Hub, so the agent
  starts from the real contract. It is told what changed (operations and schemas added, removed
  or changed), and to regenerate what the project derives from the copy and fix what no longer
  compiles or passes, such as fixtures that miss new required fields. Features on new endpoints
  are left for a plan.
- **It goes through QA and review like any task**, so the update reaches the project as a pull
  request to merge.
- **Once per project and version of the API:** a task you cancel isn't queued again, and a copy
  already synced on GitHub (by hand, say) is noticed after catching up.
- Only a `docs/openapi.json` titled "ASO Hub API" counts; other API descriptions are left alone.
  `apiSync: false` (in `startHub`) turns it off.

#### Drain and restart from the console

Tap a worker on the console's home page:

- **Drain**: it finishes its current job but gets no new ones, for example before you take
  the machine offline. **Resume** undoes it.
- **Restart**: drains the worker, then restarts it once its job is done (at once when idle),
  on the aso build installed on that machine. **Cancel restart** works until then. The worker
  comes back under a new name a few seconds later.

Restart needs a worker installed with `aso service install`, because systemd is what starts it
again; for a hand-started worker the console says so. The Architect cannot do either: it plans,
and the Hub schedules.

> **Do not edit the target directory by hand while the Hub runs.** The Hub merges approved
> work into its `main` checkout. If that checkout has uncommitted changes or a different branch
> checked out, the merge is refused and the task fails with "merge blocked".

### Planning work with the Architect

Describe what you want; the Architect plans it and you approve before anything runs:

```bash
aso plan "Add user accounts: a users table, signup/login API routes, a login page, and tests"
aso plan --file requirements.md        # longer requirements
```

1. **Exploration.** The Architect explores a read-only checkout of `main` and calls Claude
   through the Hub.
2. **Proposal.** It proposes tasks with roles, acceptance criteria and dependencies, and
   `aso plan` streams its progress and shows the plan.
3. **Questions.** When the requirement leaves open something that changes the plan (what
   the feature should do, which data it keeps, which approach), the Architect asks up to five
   questions instead of guessing. Answer them in the console or at the `aso plan` prompt.
   It then plans again with your answers.
4. **Approval or changes.** Answer `y` to create the tasks, or type what should change ("use
   SQLite, and split the UI into its own task"). The Architect revises its plan and proposes
   again. Use `aso plan-approve` / `aso plan-reply` / `aso plan-reject <planId>` from scripts,
   or `--yes` to approve without asking.
5. **Ordering.** A task waits until every task it depends on is merged into `main`.
   Independent tasks run in parallel on different workers.

Each reply starts a new planning round. The Architect re-reads the project, with the whole
conversation (its questions, your answers, earlier proposals and your requested changes) in
its prompt. A plan takes at most 10 replies. Planning a typical requirement costs well under
a dollar, capped at $3 per round (`--plan-budget`), which leaves room to read a large codebase
first; the plan shows its total cost.
The tasks themselves are capped by `--task-budget` each.

### Submitting a task directly

You can also submit single tasks through the API:

```bash
curl -X POST http://localhost:7420/api/tasks \
  -H 'content-type: application/json' \
  -d '{"role":"backend","kind":"db_migration","title":"Add users table","description":"Prisma model + migration"}'
```

`GET /api/tasks/<id>` and the dashboard show the task's state, the node working on it, any
rework rounds, and an event history.

## The console

The console is the Hub's web UI at `http://<hub-ip>:7421`. It's designed for a phone first,
and it works on a laptop too. On a phone, use **Add to Home Screen** to open it like an app.

- **Home.**
  - **Needs you** comes first: plans waiting for approval and failed tasks, across all
    projects.
  - Then your **projects** (with what each needs, a failed deploy included), work running
    anywhere, and the workers.
  - **The Hub's version and update**, for a Hub that updates itself: up to date, testing or
    waiting to install an update, restarting, updated, or why an update failed (also as a banner).
  - It refreshes every few seconds while the screen is on.
- **Project.**
  - That project's plans, running and queued tasks, and finished work.
  - **Deploy**, for a project with a deploy command: the last deploy (running, deployed, or
    failed with the reason and its output) and **Deploy now**.
  - **New plan** from here plans for this project.
  - **+ New project** on the home screen creates a new repository in the projects folder.
    The name is checked as you type, and the folder it will create is shown.
- **Task.**
  - **Live** shows the agent's work as a terminal: its messages, the commands it runs with
    their output, file edits, Hub events and QA results. Finished tasks keep this transcript.
  - **Details** shows the description, acceptance criteria, files touched and history.
  - **Cancel** a task that's going the wrong way, or **Retry** a failed one.
- **Plan.**
  - Shows the requirement, the Architect's approach and the proposed tasks.
  - **Approve and start** or **Reject** from a bar at the bottom of the screen.
  - After approval, each task shows its live state.
  - "How the Architect worked" replays how it explored the project.
- **New plan.** Pick the project (if you have several) and describe what you want. The
  Architect proposes a plan for you to approve.

**Sign-in.**
- **Sign-in link (easiest on a phone):** run `aso console-link` on the Hub machine, or tap
  **Sign in another device** in a console that's already signed in. You get a link and a QR
  code. Opening it signs that device in.
  - The link works **once, within 10 minutes**, and doesn't contain the token, so a link left
    in a chat or in browser history is useless afterwards.
  - The code is used from the page, not by opening the link itself, so chat apps that
    preview links can't use it up.
- **Session:** sign in once with the ASO token. It's kept in an `httpOnly` cookie, so page
  scripts never see it.
- **Scripts:** HTTP Basic auth (any user name, the token as password) still works for scripts.
- **Proxy:** the browser reaches the Hub only through the console's server, which adds the
  token itself and allows only the endpoints the console uses.

## Remote access with Tailscale

The Hub's ports are only on your LAN. To use the console from anywhere, without exposing it
publicly, put the Hub machine and your phone on the same
[Tailscale](https://tailscale.com) tailnet and serve the console over HTTPS inside it:

```bash
curl -fsSL https://tailscale.com/install.sh | sh   # on the Hub machine
sudo tailscale up --operator=$USER                 # log in once; lets your user manage serve
tailscale serve --bg 7421                          # https://<machine>.<tailnet>.ts.net → console
```

Approve the "enable Serve" link Tailscale prints the first time. It also turns on HTTPS
certificates for the tailnet. Then install the Tailscale app on your phone and sign in with
the same account. The console works from anywhere at `https://<machine>.<tailnet>.ts.net`:

- **Only your tailnet** can reach it.
- **The sign-in cookie is `Secure`.**
- **Redirects keep the HTTPS address,** because the console honours `X-Forwarded-Proto` and
  `X-Forwarded-Host`.
- **Links follow it:** `aso console-link` uses this address automatically while it's being
  served.

`tailscale serve --bg` survives reboots. `tailscale serve --https=443 off` stops it.

## Notifications on your phone

The Hub can notify your phone when:
- a plan is ready for your approval, or the Architect has questions,
- a task fails, or planning fails,
- all of a plan's tasks are merged (or a task submitted on its own is merged),
- a project deployed, or its deploy failed (see [Deploying after a merge](#deploying-after-a-merge)),
- a worker machine has been offline for 10 minutes, and again when it is back. The Hub
  remembers its machines across restarts, so one that never reconnects is still reported.

Tapping a notification opens that plan or task (or, for a worker, the home page) in the console. To turn them on, open the console
at its **https** address (Tailscale, above), tap **Notifications** at the bottom of the home
page, then **Turn on notifications**, and **Send a test**. Do this on each device you want
notified.

- **Browsers need https for push,** so the plain LAN address (`http://<hub>:7421`) can't
  turn them on.
- **Android (Chrome):** works in the browser. Installing the console ("Add to home screen")
  is optional.
- **iPhone/iPad:** add the console to the home screen first and open it from there; Safari
  allows push only for installed web apps.
- **Delivery goes through the browser's push service** (Google's for Chrome on Android,
  Apple's for Safari). The message is end-to-end encrypted to your device; the push service
  only sees that a message was sent. The Hub needs outbound internet access to reach it.
- **Keys and subscriptions** are kept in `<projects root>/.aso/push.json` (owner-only
  permissions). Deleting it signs every device out of notifications.

## Agents

An **agent** is one job slot of a worker machine, named after both: `avalon #2` is desk 2 on
avalon. Unlike a worker's node id, which changes each time it restarts, the name stays. Each
task keeps its `crew`: the agents that implemented and tested it, including those after a
rework. The console's task page says "Built by avalon #2 · tested by canfod #1", and a
worker's page lists its agents, one per desk: what each is building or testing now, or what it
worked on last. `/api/nodes` lists each worker's `jobs` with
their desk.

## How a task flows

1. **Route.** The Hub picks the best idle worker for the task's role and hardware needs.
2. **Implement.** The worker checks out `task/<id>` from the Hub. It starts from `main`, or
   continues an existing branch when reworking. If the project has a `package-lock.json`, the
   worker runs `npm ci` first (when `node_modules` doesn't match it already), since agents may
   not install packages. `node_modules` is never committed, even without a `.gitignore`. The
   agent works through tools the worker
   executes locally until it calls `finish`, and the worker commits and pushes the branch back
   to the Hub. If the agent stops without calling `finish`, it is reminded once. If it stops
   again, the task fails with the agent's explanation, and nothing is pushed or sent to QA.
   The tools are:
   - `list_files`, `read_file`, `search`
   - `view_image`, to look at a screenshot the agent saved (agents are asked to check visual
     changes this way before they finish, since tests can pass while something looks wrong)
   - `write_file`, `edit_file`, `delete_file`
   - `run_command` (no shell, no git)
   - `request_dependencies`, `set_package_scripts`
3. **Verify.** The Hub checks that the reported commit is the head of `task/<id>` and doesn't
   touch `package.json` or lockfiles.
4. **QA.** A QA worker checks out that exact commit, runs `npm ci` if the commit has a
   `package-lock.json`, then runs the test command (`npm test` by default).
5. **Merge, review or rework.**
   - **Pass:** the Hub merges the branch into `main` with a merge commit. With
     [pull requests](#pull-requests-you-merge) on, it opens a pull request for you instead.
   - **Failure or merge conflict:** the task goes back to an implementer with the failures and
     test output attached, up to 3 rework rounds.

**If a worker drops off the network:**

- **Not started yet:** the task is reassigned immediately.
- **Already started:** the task is held for that worker for 5 minutes. If the worker
  reconnects and is still running the job, it continues. Otherwise the Hub reassigns the task
  from the last pushed state and ignores further updates from the old worker.

A task is failed after 3 node losses.

**You can step in** at any point: cancel a task that's going the wrong way, or retry a failed
one. A retry gets fresh limits and budget, and the agent is told why it's running again. See
[Hub endpoints](#hub-endpoints).

**If the Hub restarts** (redeploy, crash, reboot), it picks up where it left off. Each
project's tasks, plans and transcripts are saved in its `.git/aso/` directory, so they stay
with the project and never end up in a commit or a worker's clone. Agent conversations are
saved in `~/aso-projects/.aso/`. On restart:

- **Started jobs** are held for 5 minutes, as if their worker had dropped off. The worker
  reconnects on its own, and its agent continues the same conversation.
- **Jobs not started yet** go back to the queue. This doesn't count as a node loss.
- **Hub-side steps** (verifying a push, merging) run again.
- **Plans** the Architect was working on are planned again; proposed plans still wait for
  approval.

Delete a project's `.git/aso/` while the Hub is stopped to start that project with an empty
task list. A state file the
Hub can't read is renamed to `state.json.unreadable-<time>` and the Hub starts empty.

**The acceptance check.** Passing tests show the code runs, not that it does what the task
asked. So after QA passes, the Architect's model reads the task, its acceptance criteria and the
diff, and judges each criterion *met*, *unmet* or *unclear*. If any is unmet, the task goes back
to its agent with what's missing (a rework round). Otherwise it moves on to review or merge, and
the verdict, criterion by criterion, goes into the pull request. If the check can't decide (no
model, a model error), the work moves on with a note. It costs one short call per round (a few
cents with Opus), counted in the task's cost; `--no-acceptance-check` turns it off.

## Projects

One Hub runs several projects at the same time. They share the workers and the Architect.

- **Where.** Every git repository directly in the projects folder (`~/aso-projects`, or
  `--root`) is a project, named after its folder.
  - Names are lowercase letters, digits, `-` and `_`.
  - Folders that aren't git repositories or have other names are skipped, with a log line.
- **New projects.** `POST /api/projects {"name": "my-app"}`, or the console, creates
  `~/aso-projects/my-app` as a git repository with an empty first commit on `main`. An
  existing folder is never taken over.
- **Connected to GitHub.** Add `"github": "owner/repo"` (or the repository's URL), or fill in
  *GitHub repository* in the console. First create the repository on GitHub and add it to the
  Hub's fine-grained token (*Repository access*). The Hub checks that the token can write to it
  and that its default branch is `main`. An empty repository gets the first commit pushed; one
  with code is cloned. Its `origin` is set, so `main` is pushed after merges and work goes to
  pull requests from the first task. Nothing is created if a check fails, and the token is
  never written to `.git/config`.
- **Separate state.** Each project has its own plans, tasks, transcripts and push-to-origin
  settings (its own `origin` remote), kept in its `.git/aso/`.
- **Ids are global.** Task and plan ids are unique across projects, so `/api/tasks/<id>` and
  `/api/plans/<id>` work without naming the project. Creating a plan or task takes a
  `project` field, which can be left out when there's only one project. Lists take
  `?project=` to filter.
- **Shared workers.** Workers take work from every project. Each worker keeps one checkout
  per project (`~/.aso/work/<project>`), cloned from `/git/<project>.git`. When a node frees
  up, the Hub dispatches across all projects, starting with a different project each time so
  none is starved.
- **CLI.** `aso plan --project my-app "…"` and `aso sync --project my-app`. The project can
  be left out when there's only one.

## Package changes: dependencies and scripts

Workers may never edit `package.json` or lockfiles. Agents ask the Hub instead:

- **`request_dependencies`** adds up to 30 packages in one request
  (`{ packages: [{ name, version?, dev? }] }`). Agents are told to request everything they
  need at once.
- **`set_package_scripts`** adds or updates npm scripts such as `test`, `build`, `dev` and
  `lint`.

**Empty projects work.** If the target has no `package.json` yet, the Hub creates a minimal one
(`name` from the folder, `version: 0.1.0`, `private: true`) with the first change. QA runs
`npm test`, so agents are told to set a `test` script when they add tests.

For a dependency, the flow is:

1. **Pause.** The worker reports `waiting_dependency` and sends a request to the Hub.
2. **Hub install.** Under the `main` lock, the Hub runs
   `npm install <pkgs> --package-lock-only --ignore-scripts` (one run for runtime packages, one
   for dev packages). This only updates `package.json`
   and `package-lock.json`: no `node_modules` on the Hub, and no package code ever runs there.
3. **Commit and reply.** The Hub commits both files to `main` in one commit,
   `chore(deps): add <pkgs>` (more than three are listed in the commit body), and replies
   with the commit.
4. **Rebase and install.** The worker rebases its task branch onto the new `main`, keeping the
   agent's uncommitted edits, and runs `npm ci`. Then the agent continues.

Script changes follow the same path. The Hub edits `package.json` directly, keeping its
formatting and other fields, and no `npm ci` is needed afterwards. Install lifecycle scripts
(`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, …) are refused, so installs
never run agent-defined hooks automatically.

Rules:

- **Who can ask.** Only the node currently implementing a task can request package changes for
  it, at most 10 requests per task. One request can add many packages.
- **Allowlist.** `--allow-deps zod,@prisma/*` restricts which packages agents may add; the
  default allows any. One disallowed package rejects the whole request.
- **Rollback.** If npm fails or touches anything besides the two files, the Hub rolls back and
  the request is rejected.
- **npm only.** pnpm, yarn and bun projects are rejected with a clear message.
- **Reconnects.** Requests survive them: the worker re-sends pending requests and the Hub
  answers duplicates from its cache instead of installing twice.

## Pushing to GitHub

### Pull requests you merge

When a project's `origin` is on GitHub and the Hub has a token (`ASO_GIT_TOKEN`, below), no
task reaches `main` without you. After QA passes, the Hub pushes the task's branch and opens a
pull request describing the task, its acceptance criteria, what the agent says it did (its whole
summary), files, QA result and cost. Your
phone gets a notification, and the task shows **Review** under *Needs you* in the console.

**Review in the console.** The task's page opens on its **Changes**: every file it changes,
with the patch. Above them, *Your review* lists the pull request's checks (GitHub Actions and
other CI) and offers:

| You… | The task |
|---|---|
| **Approve and merge** | The Hub merges the pull request on GitHub, its `main` catches up, and tasks that depend on it start. With checks failing, still running or unreadable, the button says **Merge anyway** (or **Merge without waiting**) and asks first |
| **Ask for changes**, with what should change | goes back to an agent with your words, and the pull request gets a comment saying so. Its new commits go through QA and update the same pull request, which waits for you again. These rounds have no limit |
| **Cancel task** | is cancelled, and its pull request closed |

**Or review on GitHub,** where the same decisions work:

| You… | The task |
|---|---|
| **Merge** the pull request | is merged. The Hub's `main` catches up with GitHub's, and tasks that depend on it start |
| Submit a review with **Request changes**, or with **Comment** on a pull request opened as you | goes back to an agent with your review and its comments on the code, as above |
| **Close** the pull request | is cancelled |

The Hub opens pull requests as the token's owner, usually you, and GitHub lets no one request
changes on their own pull request: there the review form offers only **Comment**, so a
submitted Comment review from you sends the work back too. Comments in the conversation (not
in a review) don't. A pull request that conflicts with `main` (often because another one was
merged first) goes back to an agent: the worker restarts the branch from `main` with the task's
changes re-applied, the conflicting files keep `<<<<<<<`/`>>>>>>>` markers, and the agent
resolves them and can't hand the work in until they're gone. The Hub checks pull requests every 30 seconds; `aso sync` checks now.

The token needs **Pull requests: read and write** as well as *Contents: read and write*. For
the console to show checks, also give it **Actions: read** and **Commit statuses: read** (a
fine-grained token can't have *Checks*, so the Hub reads GitHub Actions results through
*Actions*). Without them the checks show as unreadable, and approving asks you to merge
anyway. Set
`ASO_PULL_REQUESTS=0` to merge on the Hub instead. A project's page in the console says which
of the two it does, and why.

### QA screenshots

Tests can pass while a change looks wrong. A project can have QA take screenshots, so you see
the result next to the diff:

1. **Add a `screenshots` npm script.** After the tests pass, for a change that lists views (see
   2), the QA worker runs `npm run screenshots` with `ASO_SCREENSHOT_DIR` set to an empty folder. The script saves images there,
   e.g. a Playwright spec that calls `page.screenshot({ path: path.join(process.env.ASO_SCREENSHOT_DIR, "home-dark.png") })`.
2. **Shots of the change.** A developer agent whose change shows in the UI lists the views that
   show it when it finishes, e.g. `{"name": "task-dark-phone", "path": "/tasks/t-1", "theme":
   "dark", "width": 412}`. QA passes the list as JSON in `ASO_SCREENSHOT_TARGETS`, and the script
   saves each as `<name>.png`. The fields are `name`, `path`, and optional `theme` (`light` or
   `dark`), `width`, `height`, `selector` (shoot one element) and `state` (the project's own name
   for the data a page needs, e.g. a mock scenario). A change that lists no views (a server route,
   a test, a library function) gets no screenshots, so a pull request never shows pictures that
   have nothing to do with it. Run by hand without the variable, the script takes its default
   views. The shots come from the tested commit, not from the agent. The Architect plans
   a screenshots script for a project with a UI that has none.
3. **Limits.** QA keeps up to 12 PNG, JPEG, GIF or WebP files from the top of that folder, in
   name order: up to 2 MB each and 4 MB together. Names may use letters, digits and `._-`.
   The QA summary says what was left out and why, and names the listed views the script did not
   save (its output, with the reasons, is in the QA worker's log).
4. **Never a failure.** A screenshots script that fails or times out (5 minutes) is noted in
   the QA summary; the tests passed, so QA still passes.
5. **Where to see them.** The task's page in the console has a **Screenshots** tab. The pull
   request lists them and, with `--console-url`, links to that page; GitHub can't show the images
   themselves, because they stay on the Hub (`GET /api/tasks/{id}/screenshots/{name}`).
6. **One set per task.** A later passing QA run replaces them. A run that takes none removes them,
   because they would show an older commit.

### Pushing main

If the target repository has an `origin` remote, the Hub pushes `main` to it after every
merge. A burst of merges becomes one push. Each merged task's history notes the push (or its
failure), and so do the dashboard and `aso sync`.

| Situation | What the Hub does |
|---|---|
| Push succeeds | Done; status `idle` with the last pushed commit |
| Someone pushed to GitHub's `main` meanwhile | Merges `origin/main` into `main` (merge commit) and pushes again |
| A pull request merged by hand on GitHub, or any push to its `main` | The Hub catches up within 2 minutes, and before the Architect plans or a plan is approved, so planning and new tasks start from it. The project then deploys it, as after any merge |
| That merge conflicts | Stops pushing (status `conflict`) and leaves both sides untouched. Resolve it in the Hub's checkout, then run `aso sync` |
| Network/auth error | Retries every 5 minutes and after the next merge; `aso sync` retries now |
| No `origin` remote, or `--no-push` | Merges stay local |

**Credentials:**

- **Native Hub:** pushes use your normal git setup (SSH agent, credential helper).
- **Hub in Docker, HTTPS remote:** put a GitHub **fine-grained token**, limited to that
  repository with *Contents: read and write*, in `ASO_GIT_TOKEN` (e.g. in the `.env`). It's
  sent only to the remote's host, as a header, and never written to `.git/config`.
- **Hub in Docker, SSH remote:** the container has no SSH keys. Use an HTTPS remote with a
  token, or run the Hub natively.
- **Pull requests:** opening them always needs `ASO_GIT_TOKEN`, also for a native Hub, since
  they go through GitHub's API. Add *Pull requests: read and write* to the token.
- **Branch protection:** if GitHub's `main` requires pull requests, merging through pull
  requests works, but the Hub's own pushes of `main` (after a dependency change) are rejected,
  and the error shows in `aso sync`.

## CLI reference

### `aso start-hub`

| Option | Default | Description |
|---|---|---|
| `-r, --root <dir>` | `~/aso-projects` (`ASO_PROJECTS_ROOT`) | Folder of projects; each git repository in it is a project, and new ones are created there. Created if missing |
| `--docker` | off | Run the Hub and dashboard in Docker; the Architect stays on the host |
| `-p, --port <port>` | `7420` | Hub API, WebSocket and Git port |
| `--host <host>` | `0.0.0.0` | Interface to bind (in Docker mode: the published-port bind address) |
| `--dashboard-port <port>` | `7421` | Dashboard port |
| `--test-command <cmd>` | `npm test` | QA command, split on spaces, run without a shell |
| `--no-qa` | | Merge verified work without a QA run |
| `--no-acceptance-check` | | Don't check QA-passed work against its acceptance criteria (see [How a task flows](#how-a-task-flows)) |
| `--no-push` | | Keep merges local (don't push `main` to `origin`) |
| `--allow-deps <list>` | any | npm packages agents may request; `@scope/*` allows a scope |
| `--console-url <url>` | *(none)* | The console's address. Pull requests then link to their task, e.g. for its QA screenshots |
| `--model <id>` | `claude-opus-5-5` | Claude model for the Architect, and for agents without `--agent-model` |
| `--agent-model <id>` | `--model` | Claude model for the builder and QA agents. The Architect keeps `--model`: a strong planner breaking work into small, clear tasks lets a cheaper model build them |
| `--effort <level>` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--task-budget <usd>` | `5` | Estimated LLM spend cap per task |
| `--plan-budget <usd>` | `3` | Estimated LLM spend cap per planning round |
| `--max-turns <n>` | `80` | Model turns per task attempt or planning round. The agent is told to wrap up in its last 10; if it is still cut off, its unfinished work is pushed to the task branch for a retry |
| `--llm-concurrency <n>` | `4` | Concurrent model requests across all workers and the Architect; jobs beyond it wait their turn |
| `--no-dashboard` | | Skip the dashboard (not supported with `--docker`) |
| `--no-architect` | | Do not start the Architect |
| `--discovery-port <port>` | `7419` | UDP port this machine answers workers' [LAN discovery](#finding-the-hub-on-the-lan) on |
| `--no-discovery` | | Don't answer LAN discovery: workers then need `--hub` |
| `--update-from <git-url>` | `ASO_UPDATE_FROM` | Keep the Hub on that ASO repository's `main` (see [Automatic Hub updates](#automatic-hub-updates)). Only for an installed package run as the Hub service |

### `aso start-worker`

Profiles the machine (CPU, RAM, Docker, disk write speed) and connects to the Hub. A worker
doesn't choose what it works on: the Architect gives each task a role, and the Hub sends it to
the best free machine. If the
connection drops, the worker reconnects with exponential backoff. Without `--hub`, it asks the
LAN where the Hub is before each attempt, so it follows a Hub that moved. While offline it queues
outgoing messages and sends them once it has registered again.

| Option | Default | Description |
|---|---|---|
| `--hub <address>` | found on the LAN | `192.168.1.10`, `hub.lan:7420`, or `ws://…`. Without it, the worker [finds the Hub on the LAN](#finding-the-hub-on-the-lan) |
| `-p, --port <port>` | `7420` | Hub port, if `--hub` doesn't include one |
| `-w, --work-dir <path>` | `~/.aso/work` | Where the project checkouts live; the I/O benchmark runs here |
| `--slots <n>` | from the machine | Jobs to run at once, 1–16, each in its own checkout (`<project>`, `<project>.2`, …). The default is one per 2 threads and 6 GiB of RAM, at most 4, and 1 with `--sandbox none` (jobs would share ports) |
| `--token <token>` | `ASO_TOKEN` / worker key / token file | What to connect with (normally the machine's worker key) |
| `--join <code>` | | Join the Hub with a one-time code from `aso worker-key new`: the machine gets its own worker key |
| `--allow-insecure` | | Allow plain `ws://` to a Hub on the internet (refused otherwise) |
| `--sandbox <mode>` | `docker` | `docker`: each job command runs in a throwaway container that sees only the checkout. `none`: directly on this machine as this user. The worker refuses to start if `docker` is chosen but Docker isn't usable |
| `--sandbox-image <image>` | built on first start | Image for job commands. The default is `node:<worker's Node major>-bookworm` plus Playwright's Chromium libraries |
| `--sandbox-network <name>` | `bridge` | Docker network for job commands. `none` blocks all network access, but then `npm ci` and browser downloads fail |

### `aso service`

`aso service install [start-worker options]` installs and starts this machine's worker as a
systemd user service (see [Keep a worker running](#keep-a-worker-running-systemd)). The
other subcommands are `status`, `logs [-f] [-n <lines>]` and `uninstall`. Linux with systemd
only.

### `aso hub-service`

`aso hub-service install [start-hub options]` installs and starts the Hub as a systemd user
service (see [Keep the Hub running](#keep-the-hub-running-systemd)). The other subcommands
are `status`, `restart`, `logs [-f] [-n <lines>]` and `uninstall`. Linux with systemd only.

### `aso plan`

`aso plan [requirement...]` asks the Architect to plan a requirement. It streams the
Architect's turns, prints the proposed tasks and asks for approval.

| Option | Description |
|---|---|
| `-f, --file <path>` | Read the requirement from a file |
| `--hub <address>` | Hub address (default `127.0.0.1`, or `ASO_HUB`) |
| `-y, --yes` | Approve without asking (it still stops at questions) |

At the approval prompt, `y` approves, `n` or Enter rejects, and anything else is sent as
changes for the Architect to plan again. When the Architect asks questions, `aso plan`
prints them and reads your answers (an empty answer rejects the plan).

- `aso plan-approve <planId>` approves a proposed plan.
- `aso plan-reply <planId> <message...>` answers questions or asks for changes.
- `aso plan-reject <planId>` rejects a plan.

Without a terminal (scripts), `aso plan` prints these commands and exits.

The Architect runs in the `aso-architect` tmux session that `start-hub` starts (under
`aso hub-service`, as a child process whose output is in `aso hub-service logs`). Plans wait
while no Architect is connected.

### `aso llm-check`

Sends two tiny requests: a one-word reply (the key, model access and credit balance), then a
tool call, which agents can't work without. Prints the reply, the tokens used and the estimated
cost (a fraction of a cent). `--model <id>` checks a different model, also an
`openai:<model>` one (see [Other models](#other-models-openai-compatible-apis)).

### `aso token`

Prints the Hub's ASO token (from `ASO_TOKEN` or `~/.config/aso/token`). Give it to workers.

### `aso console-link`

Prints a one-time sign-in link for the console, and its QR code, to open on a phone or another
browser. The link works once, within 10 minutes.

| Option | Default | Description |
|---|---|---|
| `--url <base>` | Tailscale HTTPS address if `tailscale serve` proxies to the console, else the LAN address | Console address to put in the link |
| `--dashboard-port <port>` | `7421` | Console port, used to find the address |
| `--no-qr` | | Print only the link |
| `--hub <address>` | `127.0.0.1` | Hub that issues the code |

### `aso status`

The Hub at a glance in a terminal: the version it runs and where its own update stands, the
workers and what they do, and each project's work and last deploy. Exits with 1 when the Hub's
update or a project's last deploy failed, so scripts can check it. `--hub <address>` for another
machine's Hub.

### `aso deploy <project>`

Deploys the project's `main` now with its command from the Hub's `deploy.json`, follows it to
the end, and prints how it went: the commit and how long it took, or the reason and the last 30
lines of output (exit code 1). `--no-wait` only starts it. A project without a deploy command is
refused with the reason.

### `aso worker-key new`, `aso worker-keys`, `aso worker-key revoke <id>`

`new` creates a one-time join code (30 minutes) and prints what to run on the new machine. On
the LAN, that machine finds the Hub with the code. `--address` is the Hub's address as that
machine reaches it, for downloading the package and for joining from another network (default:
this machine's hostname, which on Tailscale is its tailnet name). `--name` labels the key. `aso worker-keys` lists the
keys, and `revoke` shuts a machine out.

### `aso models`, `aso desks`, `aso desk`

`aso models` lists the models desks can use (Claude, and the local server's). `aso desks` shows
each desk with a model of its own, and each such model's calls at once and load.
`aso desk <host>#<slot>|<host> <model|default>` puts a desk, or every desk of a connected
machine, on a model (`--concurrency`, `--base-url`, `--vision`). See
[A model per desk](#a-model-per-desk).

### `aso find-hub`

Asks the LAN where the Hub is, with this machine's worker key, and prints its `host:port`.
`--join <code>` asks with a join code instead. It fails with what to check when no Hub answers.

### `aso sync`

Shows the push status for the target repository's remote, and retries a failed push. Run it
after resolving a conflict. `--hub <address>` selects the Hub.

### `aso update`

Updates this machine's `aso`:

- **Installed packages:** downloads the Hub's package if its version differs, checks its
  SHA-256, and installs it.
- **Source checkouts:** pulls and rebuilds.

Options:

- `--hub <address>`: the Hub to update from (default `ASO_HUB` or `127.0.0.1`).
- `--spec <npm spec>`: install that npm spec instead.

### Deploying after a merge

The Hub can deploy a project each time work is merged into its `main`, so a merged change goes
live without anyone running a build. Give the project a command in `<projects root>/.aso/deploy.json`
on the Hub machine:

```json
{
  "aso-ui": {
    "command": "docker build -q -t aso-ui:$ASO_DEPLOY_SHORT . && docker rm -f aso-ui && docker run -d --name aso-ui --restart unless-stopped --network host -e PORT=7422 -e HOSTNAME=127.0.0.1 -e ASO_HUB_URL=http://127.0.0.1:7420 aso-ui:$ASO_DEPLOY_SHORT",
    "timeoutSec": 900
  }
}
```

- **When it runs.** After each merge into `main` (a pull request merged on GitHub or from
  the console, a merge on the Hub, or anything else that reached GitHub's `main`, picked up
  within 2 minutes), and on `POST /api/projects/<id>/deploy`. One deploy per project at a time;
  merges that land meanwhile are deployed together when it ends. A merge never deploys a commit
  that is already live; `POST /api/projects/<id>/deploy` does. The Hub remembers what is live
  (`<projects root>/.aso/deployed.json`), so when it starts it deploys what was merged while it
  was down, or a deploy a restart cut off, and nothing else.
- **Where it runs.** On the Hub machine, with `sh -c`, in a clean export of `main` at the merged
  commit (`<projects root>/.aso/deploy/<id>/`, no `.git`). With `aso start-hub --docker`, the
  container has no Docker or host tools, so the `aso start-hub` process on the host runs the
  command: it takes jobs from the Hub (`GET /api/deploys/next`) and reports the result back. `ASO_DEPLOY_PROJECT`,
  `ASO_DEPLOY_COMMIT` and `ASO_DEPLOY_SHORT` (7 characters) say what it is deploying.
- **What it sees.** Only a few variables of the Hub's environment (`PATH`, `HOME`, `USER`,
  locale, `TMPDIR`, `XDG_RUNTIME_DIR`, `DOCKER_HOST`, `DOCKER_CONFIG`) plus the entry's own
  `env`. The Hub's GitHub and Anthropic tokens are not passed on.
- **Limits.** `timeoutSec` 10–3600, default 900; on timeout the command and its children
  are stopped.
- **Results.** Your phone gets *"aso-ui: deployed"* or *"aso-ui: deploy failed"* with the last
  lines of output. `GET /api/projects/<id>` shows the latest deploy under `deploy.last`, and
  `<projects root>/.aso/deploy/<id>.log` has the end of its output.
- **Edits apply at once.** The file is read on every deploy; no Hub restart needed. Without
  an entry, a project doesn't deploy.

## Hub endpoints

The full description is **OpenAPI 3.1**: every Hub serves it at `/api/openapi.json` (no token
needed), and [`docs/openapi.json`](docs/openapi.json) is the same document in this repository.
Point a client generator or an API viewer at either to build on the Hub, for example a UI of
your own. The request and answer shapes come from the Zod schemas in `@aso/shared`
(`packages/shared/src/api.ts`), which the Hub validates request bodies with. Tests check that
every route is described and that real answers match. After changing the API, run
`npm run openapi` to update `docs/openapi.json`; a test fails until you do.

Answers can gain fields over time: clients should ignore fields they don't know.

**Authentication:**

- **Protected endpoints:** everything except `/api/health`, `/api/version`,
  `/api/openapi.json` and `/dist/aso.tgz` requires the ASO token, as
  `Authorization: Bearer <token>`.
- **Git and browsers:** these use HTTP Basic auth with any user name and the token as the
  password.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Without a token: `{status, auth}`. With it: also target, state directory, main branch, QA, sync status, connections, uptime |
| `GET` | `/api/version` | Version and SHA-256 of the `aso` package this Hub serves (public) |
| `POST` | `/api/worker-keys/join-codes` | A one-time code (30 min) a new worker machine trades for its own key |
| `POST` | `/api/worker-keys/join` | For the joining machine (public: the code is the credential): its worker key, shown once |
| `GET` | `/api/worker-keys` | The worker keys: name, connected, last used, revoked |
| `POST` | `/api/worker-keys/{id}/revoke` | Revoke a key: its machine is disconnected and can't come back with it |
| `GET` | `/api/models` | The models desks can use, and the Architect's and default ones |
| `GET` | `/api/desks` | Each desk with a model of its own, and each such model's calls at once and load |
| `POST` | `/api/desks` | Put a desk (`<host>#<slot>`) or a machine (`<host>`) on a model, or back on `default` |
| `POST` | `/api/discovery/proof` | For the Hub machine's LAN discovery: the proof answering a worker's query, if the Hub holds its credential |
| `GET` / `POST` | `/api/hub/update` | Where the Hub's own update stands (`off` without `--update-from`) / the updater on the Hub machine reports it |
| `GET` | `/api/openapi.json` | This API as an OpenAPI 3.1 document (public) |
| `GET` | `/dist/aso.tgz` | The `aso` package for installing/updating machines (public; contains no secrets) |
| `GET` | `/api/deploys/next` | For the host runner of a Hub in Docker: take the next deploy job (404 when the Hub runs deploys itself) |
| `POST` | `/api/deploys/{id}/result` | For the host runner: report how a deploy job went |
| `POST` | `/api/projects/{id}/deploy` | Deploy the project's `main` now with its command from `deploy.json` (409 without one) |
| `GET` / `POST` | `/api/sync` | Push status / retry the push of `main` to `origin` |
| `GET` | `/api/llm` | LLM status: the Architect's and the agents' models, queue, calls and estimated spend since start |
| `GET` | `/api/nodes` | Registered nodes with hardware, latest heartbeat, current task, the aso build each runs (`version`), `outdated` (a different build than the Hub serves), `supervisor`, `updates` (`package`: it can update itself), `draining`, `restart`, `updateTo` (the build a pending or running update installs), `updateError` (why the Hub stopped updating that machine) and `actions` (what the console may do now, with `why` for a refusal) |
| `GET` | `/api/tasks` | All tasks with state, nodes, commits, rework round, `crew` (the agents that built and tested it) and history |
| `GET` | `/api/tasks/:id` | A single task (history, agent turn log, LLM cost, files touched) |
| `GET` | `/api/tasks/:id/transcript`, `/api/plans/:id/transcript` | What the agent said and did: text, tool calls, command output, events, QA verdicts. `?after=<seq>` returns only newer entries |
| `POST` | `/api/tasks/:id/cancel` | Stop a task that isn't finished; a worker still on it is cut off at its next model turn |
| `POST` | `/api/nodes/:id/drain` · `/resume` | Stop or resume giving a worker new jobs; its current job finishes. Resume also cancels a pending restart |
| `POST` | `/api/nodes/:id/restart` | Drain a service worker and restart it once idle (`restart`: `pending`, then `sent`). 409 for a hand-started worker |
| `POST` | `/api/tasks/:id/retry` | Queue a failed or cancelled task again with fresh limits and budget |
| `GET` | `/api/push` | Push notifications: the Hub's public key (`applicationServerKey`) and how many devices are subscribed |
| `POST` | `/api/push/subscriptions`, `/check`, `/delete` | Add a device's `PushSubscription` (https endpoint, `p256dh`, `auth`), ask whether one is subscribed, remove one |
| `POST` | `/api/push/test` | Send a test notification, to `{ "endpoint" }` or every device |
| `POST` | `/api/sign-in-codes`, `/api/sign-in-codes/redeem` | Create a one-time console sign-in code (10 minutes, single use) / use one up. The console redeems codes server-side |
| `POST` | `/api/plans` | Start a plan: `{ "requirement": "..." }` → `201` with `planId` |
| `GET` | `/api/plans`, `/api/plans/:id` | Plans with state, summary, proposed tasks, cost |
| `POST` | `/api/plans/:id/approve` / `reject` | Decide on a proposed plan; approve returns the created task ids. Plans with questions can be rejected too |
| `POST` | `/api/plans/:id/reply` | `{ "message" }`: answer the Architect's questions (`awaiting_input`) or ask for changes to a `proposed` plan; it is planned again. `409` in other states or after 10 replies |
| `POST` | `/api/tasks` | Submit a task: `role`, `title`, `description`, optional `kind`, `taskId`, `acceptanceCriteria`, `files`, `dependsOn` (existing task ids). Returns `201`, `400` (validation) or `409` (duplicate id) |
| `GET` (WS) | `/ws` | Agent WebSocket endpoint (see [protocol](ARCHITECTURE.md#4-communication-protocol)) |
| Git | `/git/<project>.git` | Clone and fetch a project. Pushes are limited to creating or updating `task/<id>` branches |

## Agent roles

| Role | Focus (preferred stack; the project's own stack wins) | May write |
|---|---|---|
| Architect | Planning and task delegation. Writes no code | Nothing (read-only tools + `submit_plan`) |
| `backend` | Data models, database, API routes (Prisma + PostgreSQL, Hono) | Anything except `package.json`/lockfiles |
| `frontend` | UI pages, components, styling (Next.js App Router, Tailwind, shadcn/ui) | Anything except `package.json`/lockfiles |
| `qa` | Tests only, never feature code (Vitest, Playwright) | Test files, fixtures and test config (`**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/e2e/**`, `**/fixtures/**`, `**/__fixtures__/**`, `vitest/playwright/jest` config, …) |
| `devops` | Containers and CI (Docker, GitHub Actions) | `Dockerfile`s, compose files, `.github/**`, `infra/**`, `deploy/**`, `scripts/**`, `Makefile`, … |

**Where the scopes are enforced:**

- **The Architect's plan.** Its instructions list every role's scope, generated from the same
  patterns, and tell it to give each task a role that may change every file it needs, or to
  split the task.
- **Worker tools.** A QA agent's attempt to edit `src/app.ts` is refused with an explanation.
- **Hub, before QA.** A task branch that touches files outside its role's scope goes back for
  rework.

Backend and frontend are separated by their prompts rather than by paths, because project
layouts vary too much for a fixed rule. Each role has its own system prompt; see
`packages/hub/src/llm/prompts.ts`.

## Task kinds and routing

The Architect gives each task a **role**, which decides *what* the agent may do (tools, prompt,
writable files). Workers don't pick roles: every worker runs whatever role it is sent. The
task's **kind** decides *where* it runs best:

| Kind | Hard requirement | Preference |
|---|---|---|
| `feature` (default) | — | CPU-heavy (60% CPU, 20% RAM, 20% I/O) |
| `unit_test` | — | balanced, CPU-leaning; also used for QA runs |
| `e2e_test` | ≥ 4 GiB total RAM | most free RAM (70%) |
| `db_migration` | — | fastest disk writes (80%) |
| `container_build` | running Docker daemon | balanced |

**Several jobs per machine.** A worker runs as many jobs at once as it has slots (see
`--slots`), so one big machine works through independent tasks in parallel.

**Work spreads over the machines first.** A job goes to the eligible machine running the
fewest jobs, so two tasks at once run on two machines when there are two, however different
their hardware. Only among equally busy machines do the kind's preferences pick the strongest.
Agents spend most of their time waiting for the model, so a stronger machine barely speeds them
up, while builds and tests on one machine compete for it. Model calls from all jobs share the
Hub's `--llm-concurrency` limit.

**QA runs on another machine** than the one that wrote the code, if another worker is free, so
the tests start from a fresh checkout and setup. With a single worker, or when every other
worker is busy, the writer runs QA itself rather than waiting.

For the scoring formula, see [ARCHITECTURE.md](ARCHITECTURE.md#6-hardware-aware-routing).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ASO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ASO_TOKEN` | token file | The shared ASO token (workers, CLI). The Hub reads/creates `~/.config/aso/token` when unset |
| `ASO_HUB` | `127.0.0.1` | Default Hub address for `aso plan`, `sync`, `update` |
| `ASO_GIT_TOKEN` | *(none)* | Hub only: token for pushing to an HTTPS `origin` (e.g. GitHub fine-grained token) |
| `ASO_PUSH` | `1` | `0` keeps merges local (same as `--no-push`) |
| `ASO_CONFIG_DIR` | `~/.config/aso` | Where the token file and `.env` live |
| `ASO_ENV_FILE` | *(none)* | An extra `.env` file to load (highest priority after the shell) |
| `ASO_TEST_COMMAND` | `npm test` | Default for `--test-command` (also passed into the container) |
| `ASO_QA` | `1` | `0` disables QA (same as `--no-qa`) |
| `ASO_AUTO_UPDATE` | `1` | `0` stops the Hub from updating outdated workers itself |
| `ASO_PULL_REQUESTS` | `1` | `0` merges QA-approved work on the Hub instead of opening GitHub pull requests |
| `ASO_ALLOW_DEPS` | *(any)* | Default for `--allow-deps` (also passed into the container) |
| `ASO_CONSOLE_URL` | *(none)* | Default for `--console-url` (also passed into the container) |
| `ANTHROPIC_API_KEY` | *(none)* | Hub only. Without it, agents fail tasks with "no LLM configured" |
| *(file)* `.env` | — | Loaded on start: the shell's variables win, then `ASO_ENV_FILE`, then `~/.config/aso/.env`, then a source checkout's `.env`. See `.env.example` |
| `ASO_MODEL`, `ASO_AGENT_MODEL`, `ASO_EFFORT`, `ASO_TASK_BUDGET`, `ASO_PLAN_BUDGET`, `ASO_MAX_TURNS`, `ASO_LLM_CONCURRENCY` | see flags | Defaults for the LLM flags (also passed into the container) |
| `ASO_PUSH_CONTACT` | project URL | Contact (`mailto:` or `https:`) sent to push services with notifications (VAPID `sub`) |
| `ASO_UPDATE_SPEC` | `@aso/cli@latest` | Default source for `aso update` |

## Security notes

[SECURITY.md](SECURITY.md) covers the credentials (the Hub token, worker keys, join and sign-in
codes, the GitHub and Anthropic keys), what each machine holds, how to revoke and rotate them, what
contains a misbehaving agent, and the known limits. In short:

- **The Hub token stays on the Hub machine.** Workers have their own revocable keys, browsers
  sign in with one-time codes, and model calls go through the Hub.
- **Every job command runs in a throwaway Docker container** that sees only its checkout.
- **Only the Hub writes `main`,** and with pull requests on, only after you approve.
- **Traffic is plain HTTP on the LAN:** use Tailscale or a TLS proxy if the network isn't trusted.

Report vulnerabilities privately (see [SECURITY.md](SECURITY.md#reporting-a-vulnerability)).

## Development

```
packages/
  shared/     Zod protocol, agent tool schemas, role policies, plan validation, helpers
  hub/        Hono server, registry, router, tasks, plans, LLM gateway, Git endpoint + repo
  architect/  Architect node: plans requirements with read-only tools
scripts/package.mjs              Builds the distributable package (served by the Hub)
  worker/     hardware profiler, WebSocket client, job runner, AgentGitClient
  cli/        Commander.js `aso` command
  dashboard/  Next.js App Router UI
Dockerfile, docker-compose.yml   Hub image (used by `aso start-hub --docker`)
```

```bash
npm run build            # tsc -b (project references)
npm run build:dashboard  # next build (standalone server)
npm run package          # bundle the CLI (esbuild) + dashboard into release/aso.tgz
npm test                 # build + node:test (native TypeScript stripping, no extra deps)
```

The tests run against real git repositories and a real Hub on random ports. The pipeline suite
starts real workers that implement a task, fail QA, rework, pass and merge.

Tests that talk to the in-process Hub over HTTP must use async git (`gitAsync`). A synchronous
`execFileSync` would block the event loop the Hub needs to answer, and the test deadlocks.

## License

[MIT](LICENSE)
