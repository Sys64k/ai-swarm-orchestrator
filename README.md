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

<!-- swarm-stats:start -->
**Built by its own swarm.** Since 27 Oct 2026, the swarm has merged **29 tasks**, **34%** on the first try (12 finished by a stronger model taking over), from **3 of 3** proposed plans approved, at about **$1.61 per task** in model costs.

| Model | Tasks finished | First try | QA passed | Acceptance met | Plans approved | Checks it made: met | Its met held up | Cost per task started on it |
|---|---|---|---|---|---|---|---|---|
| `gemini-3.8-flash` | 12 | 50% | 23 of 25 | 12 of 21 | – | – | – | $1.88 |
| `claude-opus-5-5` | 12 | 0% | 17 of 17 | 13 of 17 | 3 of 3 | 4 of 6 | 4 of 4 | – |
| `gpt-6.1-terra` | 5 | 80% | 8 of 8 | 6 of 8 | – | – | – | $0.44 |
| `gpt-6.1-sol` | 0 | – | – | – | – | 24 of 39 | 23 of 24 | – |

<sub>Its met held up: of the work it passed as the reviewer, how much no person sent back or closed and whose deploy didn't fail.</sub>

<sub>Cost per task started on it: all in, from a task's first build to its end (every model it escalated to, its acceptance checks, a share of its plan), and failed tasks too.</sub>

<sub>From the Hub's public track record, updated daily (last: 29 Oct 2026). See [Track records](docs/models.md#track-records-how-each-model-has-done).</sub>
<!-- swarm-stats:end -->

## What it does

- **Plans with you.** Describe a requirement; the Architect explores the project, asks what it
  needs to know, and proposes small tasks with acceptance criteria for you to approve.
- **Builds on your machines.** Each task goes to the best free desk (a job slot) on your worker
  machines, where an agent edits, builds and tests the code in a throwaway container.
- **Checks before you look.** The Hub verifies each push, QA runs the tests on another machine,
  and the Architect's model checks the work against the task's acceptance criteria; anything
  missing goes back to the agent.
- **You decide what lands.** Each task becomes a GitHub pull request you merge or send back,
  from the console on your phone; merged work can deploy itself.
- **Any model, per desk.** Claude, or any OpenAI-compatible model (a local one through Ollama,
  for example), chosen per desk.
- **Runs itself.** The Hub and workers run as services, find each other on the LAN, update
  themselves from `main`, and notify your phone.

## Technologies

TypeScript on Node.js (a monorepo: Hub, worker, Architect, CLI), Zod for the WebSocket
protocol and the OpenAPI description, Git over HTTP, Docker for the Hub and each job's sandbox,
a Next.js console, systemd services, and the Anthropic API or any OpenAI-compatible API for
the models. Tailscale gives access from anywhere.

## Quick start

On the Hub machine (Linux with Docker, Node.js 20 or later and git), with an Anthropic API key
in `~/.config/aso/.env` (`ANTHROPIC_API_KEY=sk-ant-...`):

```bash
git clone git@github.com:Sys64k/ai-swarm-orchestrator.git aso && cd aso
npm install && npm run package && npm link -w @aso/cli
aso hub-service install --docker   # the Hub, its console and the Architect, as a service
aso worker-key new                  # prints what to run on a worker machine
aso console-link                    # a one-time link that signs your phone in to the console
```

On each worker machine (Linux with Docker and Node.js), run the two commands `aso worker-key new`
printed: one installs `aso` from the Hub, the other joins and starts the worker service. Then
describe what to build in the console, or with `aso plan "..."`.

The full setup, with options, updates and remote access, is in
[docs/installation.md](docs/installation.md).

## Documentation

| Guide | What's in it |
|---|---|
| [Installation](docs/installation.md) | The Hub and worker machines, services, updates, Tailscale, phone notifications |
| [Using ASO](docs/using-aso.md) | The console, planning with the Architect, tasks and how they flow, projects, roles |
| [Models](docs/models.md) | Claude, OpenAI-compatible and local models, a model per desk |
| [GitHub and deploys](docs/github.md) | Pull requests, pushing `main`, deploying after a merge |
| [CLI reference](docs/cli.md) | Every `aso` command |
| [Configuration](docs/configuration.md) | Settings and `.env` |
| [Hub API](docs/api.md) | The HTTP endpoints ([OpenAPI](docs/openapi.json)) |
| [Development](docs/development.md) | Building and testing ASO itself |
| [Status](docs/status.md) | What's built, phase by phase |
| [The local-model experiment](docs/local-model-experiment.md) | How simple tasks must be for a free local model, what we found, and what it changed |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The design, diagrams and protocol |
| [SECURITY.md](SECURITY.md) | Credentials, what protects what, reporting a vulnerability |

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

## License

[MIT](LICENSE)
