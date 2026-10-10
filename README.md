# AI Swarm Orchestrator (ASO)

ASO coordinates a swarm of AI coding agents across the Linux machines on your local network.
A central **Hub** splits project work into tasks and hands each one to the **Worker Node** best
suited to it. Workers edit, build and test code on their own hardware and deliver results through
Git. LLM access goes only through the Hub, so workers never hold API credentials.

```
            ┌──────────── Hub (Ubuntu server) ────────────┐
            │  API + WebSocket · Dashboard · Architect     │
            │  central Git repo · LLM gateway              │
            └───────▲──────────────▲──────────────▲────────┘
                    │ WebSocket    │              │
             ┌──────┴─────┐ ┌──────┴─────┐ ┌──────┴─────┐
             │  Worker    │ │  Worker    │ │  Worker    │
             │  Pop!_OS   │ │  CachyOS   │ │  Ubuntu    │
             └────────────┘ └────────────┘ └────────────┘
```

For the design, diagrams and protocol reference, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, `aso` CLI, Hub/Worker/Architect processes, Zod WebSocket protocol | ✅ Done. The Hub runs on the host; a Docker image is not built yet |
| 2 | Hardware profiling, node registry, hardware-aware task routing | ✅ Done |
| 3 | Git flow: `AgentGitClient` ✅; Hub-hosted repo, QA pipeline, auto-merge | 🟡 Partial |
| 4 | Dependency RPC queue (`requestDependency`) | ⏳ Planned |
| 5 | LLM gateway: prompt queue, provider adapters | ⏳ Planned |
| 6 | Agent roles: per-role system prompts and tool scopes | ⏳ Planned |
| 7 | GitHub sync, packaged global CLI, `aso update` | ⏳ Planned |

Workers can register, receive tasks and acknowledge them. They cannot execute tasks yet: the
execution loop needs the Git flow (Phase 3) and the LLM gateway (Phase 5).

## Requirements

| Machine | Needs |
|---|---|
| Hub | Node.js ≥ 20, git, tmux (for the Architect session) |
| Each worker | Node.js ≥ 20, git, plus whatever the target project needs to build and test (npm, Docker for DevOps nodes, Playwright browsers for QA nodes) |

Workers need no LLM credentials and no manual copy of the project. In Phase 3 they will fetch
the code from the Hub.

## Quick start (from source)

On **every** machine:

```bash
git clone <this repo> aso && cd aso
npm install
npm run build
```

Only the Hub needs the dashboard build:

```bash
npm run build:dashboard
```

**On the Hub:**

```bash
npm run aso -- start-hub --dir ~/projects/my-app
# Dashboard: http://<hub-ip>:7421   API/WebSocket: <hub-ip>:7420
```

**On each worker:**

```bash
npm run aso -- start-worker --hub 192.168.1.10
```

To get the `aso` command on your PATH, run `npm link -w @aso/cli` (or
`npm install -g ./packages/cli`). You can then run `aso start-hub …` directly.

### Submitting a task

Until the Architect generates tasks, you can submit them through the API:

```bash
curl -X POST http://localhost:7420/api/tasks \
  -H 'content-type: application/json' \
  -d '{"role":"backend","kind":"db_migration","title":"Add users table","description":"Prisma model + migration"}'
```

The response, `GET /api/tasks` and the dashboard all show the assigned node and the reasons it
was chosen. If no node is eligible, they show why the task is still waiting.

## CLI reference

### `aso start-hub`

Starts the Hub API and WebSocket server, the Next.js dashboard, and the Architect in a detached
tmux session.

| Option | Default | Description |
|---|---|---|
| `-d, --dir <path>` | *required* | Target project repository the swarm works on |
| `-p, --port <port>` | `7420` | Hub API and WebSocket port |
| `--host <host>` | `0.0.0.0` | Interface to bind |
| `--dashboard-port <port>` | `7421` | Dashboard port |
| `--no-dashboard` | | Skip the dashboard |
| `--no-architect` | | Skip the Architect tmux session |

Attach to the Architect with `tmux attach -t aso-architect`. The session is removed when the Hub
stops.

### `aso start-worker`

Profiles the machine (CPU, RAM, Docker, disk write speed) and connects to the Hub. If the
connection drops, the worker reconnects with exponential backoff.

| Option | Default | Description |
|---|---|---|
| `--hub <address>` | *required* | `192.168.1.10`, `hub.lan:7420`, or `ws://…` |
| `-p, --port <port>` | `7420` | Hub port, if `--hub` doesn't include one |
| `-r, --roles <list>` | all | Comma-separated: `backend,frontend,qa,devops` |
| `-w, --work-dir <path>` | `~/.aso/work` | Where task checkouts live; the I/O benchmark runs here |

### `aso update`

Runs `npm install -g` on the latest CLI. Use `--spec <npm spec>` or the `ASO_UPDATE_SPEC`
environment variable to choose the source (a registry name, git URL or tarball). Distribution is
finalised in Phase 7.

## Hub HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Status, target directory, connection count, uptime |
| `GET` | `/api/nodes` | Registered nodes with hardware, latest heartbeat and current task |
| `GET` | `/api/tasks` | All tasks with state, assigned node, routing reasons |
| `GET` | `/api/tasks/:id` | A single task |
| `POST` | `/api/tasks` | Submit a task: `role`, `title`, `description`, optional `kind`, `taskId`, `acceptanceCriteria`, `files`. Returns `201`, `400` (validation) or `409` (duplicate id) |
| `GET` (WS) | `/ws` | Agent WebSocket endpoint (see [protocol](ARCHITECTURE.md#4-communication-protocol)) |

## Task kinds and routing

The task's **role** decides *who* can take it, from the roles a worker accepts. The task's
**kind** decides *where* it runs best:

| Kind | Hard requirement | Preference |
|---|---|---|
| `feature` (default) | — | CPU-heavy (60% CPU, 20% RAM, 20% I/O) |
| `unit_test` | — | balanced, CPU-leaning |
| `e2e_test` | ≥ 4 GiB total RAM | most free RAM (70%) |
| `db_migration` | — | fastest disk writes (80%) |
| `container_build` | running Docker daemon | balanced |

Each node runs one task at a time. If a node disconnects, the Hub requeues its task (up to 3
attempts). For the scoring formula, see [ARCHITECTURE.md](ARCHITECTURE.md#6-hardware-aware-routing).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ASO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ASO_UPDATE_SPEC` | `@aso/cli@latest` | Default source for `aso update` |
| `ASO_HUB_PORT` | `7420` | Set by `start-hub` for the dashboard process |

## Security notes

- **No authentication yet.** Anyone who can reach the Hub's ports can register a node or submit
  tasks. Run ASO only on a trusted LAN until node authentication lands (planned with Phase 7).
- All WebSocket traffic is validated against strict Zod schemas. The checks include:
  - Unknown fields are rejected.
  - Paths can't escape the repository.
  - Dependency requests accept only registry package names and semver ranges.
  - Nodes can't supply their own system prompts.
- Agents never get raw Git access. `AgentGitClient` refuses to commit `package.json` or
  lockfiles; dependency changes go through the Hub.

## Development

```
packages/
  shared/     Zod protocol, constants, logger, hub address parsing
  hub/        Hono server, node registry, router, task manager, Architect entrypoint
  worker/     hardware profiler, WebSocket client, AgentGitClient
  cli/        Commander.js `aso` command
  dashboard/  Next.js App Router UI
```

```bash
npm run build            # tsc -b (project references)
npm run build:dashboard  # next build
npm test                 # build + node:test (native TypeScript stripping, no extra deps)
```

The tests cover:

- **Protocol:** schema rules.
- **Routing:** the pure router.
- **Hub:** WebSocket protocol and dispatch, run against a real Hub on a random port.
- **`AgentGitClient`:** run against real temporary repositories with a bare `origin`.
