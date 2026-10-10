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
| 4 | Dependency requests: the Hub adds npm packages on `main`, workers rebase and `npm ci` | ✅ Done |
| 5 | LLM gateway on the Hub (Anthropic API), coding agent loop on workers, per-task cost tracking | ✅ Done |
| 6 | Architect planning (`aso plan`), task dependencies, role prompts and write scopes | ✅ Done |
| 7 | GitHub sync (`git push origin main`), packaged global CLI, `aso update`, node authentication | ⏳ Planned. Until then nothing is pushed anywhere; all commits stay in the local target repo |

The whole loop runs end to end: a task is routed, and an agent on a worker explores and edits
the code. The agent verifies its work, then the change is pushed, checked by the Hub, tested by
QA, reworked if needed, and merged. Agents need an Anthropic API key on the Hub; see
[Connecting Claude](#connecting-claude).

## What runs where

| Machine | Runs | Needs |
|---|---|---|
| Hub | Hub API, WebSocket, Git endpoint and dashboard (in Docker, or directly), plus the Architect in tmux | Docker with Compose v2 (or Node.js ≥ 20 + git), tmux |
| Each worker | `aso start-worker` natively, **not** in a container | Node.js ≥ 20, git, plus whatever the target project needs to build and test (npm, Docker for DevOps nodes, Playwright browsers for QA nodes) |

Workers stay out of containers because they need the real machine: accurate hardware
profiling, the host's Docker daemon for container builds, and local toolchains.

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
3. **Put the key in `.env`** in the ASO folder, on the Hub machine:
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
| Effort | `high` | `--effort low…max` |
| Spend cap per task (estimated) | $5 | `--task-budget` |
| Concurrent model requests | 2 | `--llm-concurrency` |

The dashboard and `GET /api/llm` show calls and estimated spend; each task shows its own
turns and cost. Estimates use the Hub's price table. Your Console billing is authoritative.

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
3. **Approval.** Answer `y` to create the tasks. Use `aso plan-approve <planId>` /
   `aso plan-reject <planId>` from scripts, or `--yes` to skip the question.
4. **Ordering.** A task waits until every task it depends on is merged into `main`.
   Independent tasks run in parallel on different workers.

Planning a typical requirement costs cents (capped at $1 per plan); the plan shows its cost.
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

## How a task flows

1. **Route.** The Hub picks the best idle worker for the task's role and hardware needs.
2. **Implement.** The worker checks out `task/<id>` from the Hub. It starts from `main`, or
   continues an existing branch when reworking. The agent works through tools the worker
   executes locally until it calls `finish`, and the worker commits and pushes the branch back
   to the Hub. The tools are:
   - `list_files`, `read_file`, `search`
   - `write_file`, `edit_file`, `delete_file`
   - `run_command` (no shell, no git)
   - `request_dependency`
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

## Adding dependencies

Workers may never edit `package.json` or lockfiles. When an agent needs a package, it calls
`requestDependency({ name, version?, dev? })`:

1. **Pause.** The worker reports `waiting_dependency` and sends a request to the Hub.
2. **Hub install.** Under the `main` lock, the Hub runs
   `npm install <pkg> --package-lock-only --ignore-scripts`. This only updates `package.json`
   and `package-lock.json`: no `node_modules` on the Hub, and no package code ever runs there.
3. **Commit and reply.** The Hub commits both files to `main` as
   `chore(deps): add <pkg>` and replies with the commit.
4. **Rebase and install.** The worker rebases its task branch onto the new `main`, keeping the
   agent's uncommitted edits, and runs `npm ci`. Then the agent continues.

Rules:

- **Who can ask.** Only the node currently implementing a task can request dependencies for
  it, at most 10 per task.
- **Allowlist.** `--allow-deps zod,@prisma/*` restricts which packages agents may add; the
  default allows any.
- **Rollback.** If npm fails or touches anything besides the two files, the Hub rolls back and
  the request is rejected.
- **npm only.** pnpm, yarn and bun projects are rejected with a clear message.
- **Reconnects.** Requests survive them: the worker re-sends pending requests and the Hub
  answers duplicates from its cache instead of installing twice.

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
| `--allow-deps <list>` | any | npm packages agents may request; `@scope/*` allows a scope |
| `--model <id>` | `claude-opus-5-5` | Claude model for agents |
| `--effort <level>` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--task-budget <usd>` | `5` | Estimated LLM spend cap per task |
| `--llm-concurrency <n>` | `2` | Concurrent model requests across all workers |
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

### `aso plan`

`aso plan [requirement...]` asks the Architect to plan a requirement. It streams the
Architect's turns, prints the proposed tasks and asks for approval.

| Option | Description |
|---|---|
| `-f, --file <path>` | Read the requirement from a file |
| `--hub <address>` | Hub address (default `127.0.0.1`, or `ASO_HUB`) |
| `-y, --yes` | Approve without asking |

`aso plan-approve <planId>` and `aso plan-reject <planId>` decide on a proposed plan later.

The Architect runs in the `aso-architect` tmux session that `start-hub` starts. Plans wait
while no Architect is connected.

### `aso llm-check`

Sends one tiny request with `ANTHROPIC_API_KEY` to confirm the key, model access and credit
balance. Prints the reply, the tokens used and the estimated cost (a fraction of a cent).
`--model <id>` checks a different model.

### `aso update`

Runs `npm install -g` on the latest CLI. Use `--spec <npm spec>` or the `ASO_UPDATE_SPEC`
environment variable to choose the source (a registry name, git URL or tarball). Distribution is
finalised in Phase 7.

## Hub endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Status, target directory, main branch, QA settings, connections, uptime |
| `GET` | `/api/llm` | LLM status: model, queue, calls and estimated spend since start |
| `GET` | `/api/nodes` | Registered nodes with hardware, latest heartbeat and current task |
| `GET` | `/api/tasks` | All tasks with state, nodes, commits, rework round and history |
| `GET` | `/api/tasks/:id` | A single task (history, agent turn log, LLM cost, files touched) |
| `POST` | `/api/plans` | Start a plan: `{ "requirement": "..." }` → `201` with `planId` |
| `GET` | `/api/plans`, `/api/plans/:id` | Plans with state, summary, proposed tasks, cost |
| `POST` | `/api/plans/:id/approve` / `reject` | Decide on a proposed plan; approve returns the created task ids |
| `POST` | `/api/tasks` | Submit a task: `role`, `title`, `description`, optional `kind`, `taskId`, `acceptanceCriteria`, `files`, `dependsOn` (existing task ids). Returns `201`, `400` (validation) or `409` (duplicate id) |
| `GET` (WS) | `/ws` | Agent WebSocket endpoint (see [protocol](ARCHITECTURE.md#4-communication-protocol)) |
| Git | `/git/project.git` | Clone and fetch the target project. Pushes are limited to creating or updating `task/<id>` branches |

## Agent roles

| Role | Focus (preferred stack; the project's own stack wins) | May write |
|---|---|---|
| Architect | Planning and task delegation. Writes no code | Nothing (read-only tools + `submit_plan`) |
| `backend` | Data models, database, API routes (Prisma + PostgreSQL, Hono) | Anything except `package.json`/lockfiles |
| `frontend` | UI pages, components, styling (Next.js App Router, Tailwind, shadcn/ui) | Anything except `package.json`/lockfiles |
| `qa` | Tests only, never feature code (Vitest, Playwright) | Test files and test config (`**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/e2e/**`, `vitest/playwright/jest` config, …) |
| `devops` | Containers and CI (Docker, GitHub Actions) | `Dockerfile`s, compose files, `.github/**`, `infra/**`, `deploy/**`, `scripts/**`, `Makefile`, … |

**Where the scopes are enforced:**

- **Worker tools.** A QA agent's attempt to edit `src/app.ts` is refused with an explanation.
- **Hub, before QA.** A task branch that touches files outside its role's scope goes back for
  rework.

Backend and frontend are separated by their prompts rather than by paths, because project
layouts vary too much for a fixed rule. Each role has its own system prompt; see
`packages/hub/src/llm/prompts.ts`.

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
| `ASO_ALLOW_DEPS` | *(any)* | Default for `--allow-deps` (also passed into the container) |
| `ANTHROPIC_API_KEY` | *(none)* | Hub only. Without it, agents fail tasks with "no LLM configured" |
| *(file)* `.env` | — | In the ASO folder: loaded by `aso` on start; shell variables override it. See `.env.example` |
| `ASO_MODEL`, `ASO_EFFORT`, `ASO_TASK_BUDGET`, `ASO_LLM_CONCURRENCY` | see flags | Defaults for the LLM flags (also passed into the container) |
| `ASO_UPDATE_SPEC` | `@aso/cli@latest` | Default source for `aso update` |

## Security notes

- **No authentication yet.** Anyone who can reach port 7420 can register a node, submit tasks,
  clone the project, and push `task/*` branches. Run ASO only on a trusted LAN until node
  authentication lands (Phase 7).
- **Push restrictions.** The Git endpoint refuses pushes to `main`, tags, deletions, and
  anything outside `refs/heads/task/<id>`. Only the Hub writes `main`.
- **Checks on both sides.** Workers' `AgentGitClient` refuses to commit `package.json` or
  lockfiles. The Hub checks again before QA, so a misbehaving worker can't get around it.
- **Dependency installs.** On the Hub they never execute package code
  (`--package-lock-only --ignore-scripts`). Agents can still choose *which* packages get added,
  and workers run their install scripts during `npm ci`. Use `--allow-deps` if you want to
  control that.
- **Message validation.** All WebSocket traffic is validated against strict Zod schemas:
  - Unknown fields are rejected.
  - Paths can't escape the repository.
  - Dependency requests accept only registry package names and semver ranges.
  - Nodes can't supply their own system prompts.
- **Test commands.** QA commands come from the Hub's configuration, never from workers. They
  run without a shell, in their own process group, with a timeout.
- **Agent tools are guardrails, not a sandbox.** They catch a cooperative model's mistakes:
  - paths are confined to the checkout, including through symlinks
  - protected files are refused
  - `git`, shells, `sudo` and package installs are blocked in `run_command`

  But the agent can run project code (tests, scripts) with the worker user's permissions.
  What protects `main` is the Hub (push policy, protected-file verification, QA). Run workers
  as a dedicated user on machines you're comfortable letting agents build on.
- **API key.** It lives only on the Hub. With `--docker` it is passed into the container
  through the environment, so anyone who can run `docker inspect` on the Hub machine can read
  it.

## Development

```
packages/
  shared/     Zod protocol, agent tool schemas, role policies, plan validation, helpers
  hub/        Hono server, registry, router, tasks, plans, LLM gateway, Git endpoint + repo
  architect/  Architect node: plans requirements with read-only tools
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
