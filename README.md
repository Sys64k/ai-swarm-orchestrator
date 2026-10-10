# AI Swarm Orchestrator (ASO)

ASO coordinates a swarm of AI coding agents across the Linux machines on your local network.
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
| 4 | Dependency RPC queue (`requestDependency`) | ⏳ Planned |
| 5 | LLM gateway: prompt queue, provider adapters, **the agent loop that writes code** | ⏳ Planned |
| 6 | Agent roles: per-role system prompts and tool scopes | ⏳ Planned |
| 7 | GitHub sync (`git push origin main`), packaged global CLI, `aso update`, node authentication | ⏳ Planned |

The task pipeline runs end to end: routing, then checkout, push, Hub verification, QA, rework
and merge. The only missing piece is the component that actually writes code. Until Phase 5
adds the LLM agent loop, a worker started from the CLI reports implementation tasks as failed
with "no agent executor configured". QA test runs work today.

## What runs where

| Machine | Runs | Needs |
|---|---|---|
| Hub | Hub API, WebSocket, Git endpoint and dashboard (in Docker, or directly), plus the Architect in tmux | Docker with Compose v2 (or Node.js ≥ 20 + git), tmux |
| Each worker | `aso start-worker` natively, **not** in a container | Node.js ≥ 20, git, plus whatever the target project needs to build and test (npm, Docker for DevOps nodes, Playwright browsers for QA nodes) |

Workers stay out of containers because they need the real machine: accurate hardware
profiling, the host's Docker daemon for container builds, and local toolchains.

Workers need no LLM credentials and no manual copy of the project. They clone it from the Hub
automatically into `~/.aso/work/project`.

## Quick start (from source)

Until Phase 7 packages a global CLI, install from source on **every** machine:

```bash
git clone <this repo> aso && cd aso
npm install
npm run build
npm link -w @aso/cli        # puts `aso` on your PATH (or use: npm run aso -- <command>)
```

The target project must be a git repository with at least one commit on `main`:

```bash
git -C ~/projects/my-app init -b main && git -C ~/projects/my-app commit --allow-empty -m "Initial commit"
```

**On the Hub, in Docker (recommended):**

```bash
aso start-hub --docker --dir ~/projects/my-app
```

The first run builds the image, which takes a few minutes. The container runs as your
user ID, so files the Hub writes into your project keep your ownership.

**On the Hub, without Docker (for development):**

```bash
npm run build:dashboard
aso start-hub --dir ~/projects/my-app
```

Either way you get:

- the dashboard at `http://<hub-ip>:7421`
- the API, WebSocket and Git endpoint at `<hub-ip>:7420`
- the Architect in tmux (`tmux attach -t aso-architect`)

**On each worker:**

```bash
aso start-worker --hub 192.168.1.10 --roles backend,qa
```

> **Do not edit the target directory by hand while the Hub runs.** The Hub merges approved
> work into its `main` checkout. If that checkout has uncommitted changes or a different branch
> checked out, the merge is refused and the task fails with "merge blocked".

### Submitting a task

Until the Architect generates tasks, submit them through the API:

```bash
curl -X POST http://localhost:7420/api/tasks \
  -H 'content-type: application/json' \
  -d '{"role":"backend","kind":"db_migration","title":"Add users table","description":"Prisma model + migration"}'
```

`GET /api/tasks/<id>` and the dashboard show the task's state, the node working on it, any
rework rounds, and an event history.

## How a task flows

1. **Route.** The Hub picks the best idle worker for the task's role and hardware needs.
2. **Implement.** The worker checks out `task/<id>` from the Hub. It starts from `main`, or
   continues an existing branch when reworking. The agent edits files, then the worker commits
   and pushes the branch back to the Hub.
3. **Verify.** The Hub checks that the reported commit is the head of `task/<id>` and doesn't
   touch `package.json` or lockfiles.
4. **QA.** A QA worker checks out that exact commit, runs `npm ci` if the commit has a
   `package-lock.json`, then runs the test command (`npm test` by default).
5. **Merge or rework.**
   - **Pass:** the Hub merges the branch into `main` with a merge commit.
   - **Failure or merge conflict:** the task goes back to an implementer with the failures and
     test output attached, up to 3 rework rounds.

**If a worker drops off the network:**

- **Not started yet:** the task is reassigned immediately.
- **Already started:** the task is held for that worker for 5 minutes. If the worker
  reconnects and is still running the job, it continues. Otherwise the Hub reassigns the task
  from the last pushed state and ignores further updates from the old worker.

A task is failed after 3 node losses.

## CLI reference

### `aso start-hub`

| Option | Default | Description |
|---|---|---|
| `-d, --dir <path>` | *required* | Target project repository (repo root, with a `main` branch) |
| `--docker` | off | Run the Hub and dashboard in Docker; the Architect stays on the host |
| `-p, --port <port>` | `7420` | Hub API, WebSocket and Git port |
| `--host <host>` | `0.0.0.0` | Interface to bind (in Docker mode: the published-port bind address) |
| `--dashboard-port <port>` | `7421` | Dashboard port |
| `--test-command <cmd>` | `npm test` | QA command, split on spaces, run without a shell |
| `--no-qa` | | Merge verified work without a QA run |
| `--no-dashboard` | | Skip the dashboard (not supported with `--docker`) |
| `--no-architect` | | Skip the Architect tmux session |

### `aso start-worker`

Profiles the machine (CPU, RAM, Docker, disk write speed) and connects to the Hub. If the
connection drops, the worker reconnects with exponential backoff. While offline it queues
outgoing messages and sends them once it has registered again.

| Option | Default | Description |
|---|---|---|
| `--hub <address>` | *required* | `192.168.1.10`, `hub.lan:7420`, or `ws://…` |
| `-p, --port <port>` | `7420` | Hub port, if `--hub` doesn't include one |
| `-r, --roles <list>` | all | Comma-separated: `backend,frontend,qa,devops` |
| `-w, --work-dir <path>` | `~/.aso/work` | Where the project checkout lives; the I/O benchmark runs here |

### `aso update`

Runs `npm install -g` on the latest CLI. Use `--spec <npm spec>` or the `ASO_UPDATE_SPEC`
environment variable to choose the source (a registry name, git URL or tarball). Distribution is
finalised in Phase 7.

## Hub endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Status, target directory, main branch, QA settings, connections, uptime |
| `GET` | `/api/nodes` | Registered nodes with hardware, latest heartbeat and current task |
| `GET` | `/api/tasks` | All tasks with state, nodes, commits, rework round and history |
| `GET` | `/api/tasks/:id` | A single task |
| `POST` | `/api/tasks` | Submit a task: `role`, `title`, `description`, optional `kind`, `taskId`, `acceptanceCriteria`, `files`. Returns `201`, `400` (validation) or `409` (duplicate id) |
| `GET` (WS) | `/ws` | Agent WebSocket endpoint (see [protocol](ARCHITECTURE.md#4-communication-protocol)) |
| Git | `/git/project.git` | Clone and fetch the target project. Pushes are limited to creating or updating `task/<id>` branches |

## Task kinds and routing

The task's **role** decides *who* can take it, from the roles a worker accepts. The task's
**kind** decides *where* it runs best:

| Kind | Hard requirement | Preference |
|---|---|---|
| `feature` (default) | — | CPU-heavy (60% CPU, 20% RAM, 20% I/O) |
| `unit_test` | — | balanced, CPU-leaning; also used for QA runs |
| `e2e_test` | ≥ 4 GiB total RAM | most free RAM (70%) |
| `db_migration` | — | fastest disk writes (80%) |
| `container_build` | running Docker daemon | balanced |

For the scoring formula, see [ARCHITECTURE.md](ARCHITECTURE.md#6-hardware-aware-routing).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ASO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ASO_TEST_COMMAND` | `npm test` | Default for `--test-command` (also passed into the container) |
| `ASO_QA` | `1` | `0` disables QA (same as `--no-qa`) |
| `ASO_UPDATE_SPEC` | `@aso/cli@latest` | Default source for `aso update` |

## Security notes

- **No authentication yet.** Anyone who can reach port 7420 can register a node, submit tasks,
  clone the project, and push `task/*` branches. Run ASO only on a trusted LAN until node
  authentication lands (Phase 7).
- **Push restrictions.** The Git endpoint refuses pushes to `main`, tags, deletions, and
  anything outside `refs/heads/task/<id>`. Only the Hub writes `main`.
- **Checks on both sides.** Workers' `AgentGitClient` refuses to commit `package.json` or
  lockfiles. The Hub checks again before QA, so a misbehaving worker can't get around it.
- **Message validation.** All WebSocket traffic is validated against strict Zod schemas:
  - Unknown fields are rejected.
  - Paths can't escape the repository.
  - Dependency requests accept only registry package names and semver ranges.
  - Nodes can't supply their own system prompts.
- **Test commands.** QA commands come from the Hub's configuration, never from workers. They
  run without a shell, in their own process group, with a timeout.

## Development

```
packages/
  shared/     Zod protocol, constants, logger, hub address helpers
  hub/        Hono server, node registry, router, task pipeline, Git endpoint + repo, Architect
  worker/     hardware profiler, WebSocket client, job runner, AgentGitClient
  cli/        Commander.js `aso` command
  dashboard/  Next.js App Router UI
Dockerfile, docker-compose.yml   Hub image (used by `aso start-hub --docker`)
```

```bash
npm run build            # tsc -b (project references)
npm run build:dashboard  # next build
npm test                 # build + node:test (native TypeScript stripping, no extra deps)
```

The tests run against real git repositories and a real Hub on random ports. The pipeline suite
starts real workers that implement a task, fail QA, rework, pass and merge.

Tests that talk to the in-process Hub over HTTP must use async git (`gitAsync`). A synchronous
`execFileSync` would block the event loop the Hub needs to answer, and the test deadlocks.
