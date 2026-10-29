# Using ASO

Planning work with the Architect, submitting tasks, the console, and what happens to a task on its way to `main`.

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

## Planning work with the Architect

Describe what you want; the Architect plans it and you approve before anything runs:

```bash
aso plan "Add user accounts: a users table, signup/login API routes, a login page, and tests"
aso plan --file requirements.md        # longer requirements
```

1. **Exploration.** The Architect explores a read-only checkout of `main` and calls Claude
   through the Hub.
2. **Proposal.** It proposes tasks with roles, acceptance criteria and dependencies, and
   `aso plan` streams its progress and shows the plan. It marks logic whose correctness lives
   in edge cases **tests first** (see [Tests first](#tests-first)), and where the code already
   has what a task needs, it names it with a criterion to reuse it rather than copy it.
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

## Submitting a task directly

You can also submit single tasks through the API:

```bash
curl -X POST http://localhost:7420/api/tasks \
  -H 'content-type: application/json' \
  -d '{"role":"backend","kind":"db_migration","title":"Add users table","description":"Prisma model + migration"}'
```

`GET /api/tasks/<id>` and the dashboard show the task's state, the node working on it, any
rework rounds, and an event history.

### Tests first

With `"testsFirst": true` (or the Architect marking a planned task so), a strong model decides
what "done" means before a cheaper one builds it. Use it where a careless implementation goes wrong at the edges: merging, limits, parsing,
cutting text.

1. **The test writer** runs on the Architect's model, in the `qa` role, so it can change test
   files only. It reads the code the task touches and its existing tests, writes tests for every
   criterion and the edge cases, and runs them: they must fail because the feature is missing,
   not because a test is broken. Nothing goes to QA yet.
2. **The builder** (the desk's model, escalation as usual) gets the task with the list of tests
   and the writer's notes, and writes the code that makes them pass. A push that changes those
   tests is refused, so it can't loosen a test to fit its code.
3. **A disputed test** goes back once: a builder sure that a test is wrong gives up saying why,
   and the tests go back to their writer with that explanation (not a rework round). The writer
   fixes them or keeps them and says why. After that, giving up is an ordinary rework round.

The test writer's job isn't counted as a build in track records; its cost is part of what the
task cost all in. The pull request and the console's task page say who wrote the tests, and which.

## Agents

An **agent** is one job slot of a worker machine, named after both: `avalon #2` is desk 2 on
avalon. Unlike a worker's node id, which changes each time it restarts, the name stays. Each
task keeps its `crew`: the agents that implemented and tested it, including those after a
rework. The console's task page says "Built by avalon #2 · tested by canfod #1 · Model:
gemini-3.8-flash" (with a rework on a stronger model, "Models: gemini-3.8-flash, then
claude-opus-5-5"; a model on trial is marked "(on trial)"), and the pull request says the same
on its **Built on** line. A
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
   again, it has given up: nothing is sent to QA, its work so far is saved on the branch, and the
   task comes back as a rework round with its explanation (failing once the rounds are used up).
   An empty reply (a reasoning model's turn of thinking only) isn't a stop: the agent is asked
   again, up to 3 times in a row.
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
     [pull requests](github.md#pull-requests-you-merge) on, it opens a pull request for you instead.
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
[Hub endpoints](api.md#hub-endpoints).

**If the Hub restarts** (redeploy, crash, reboot), it picks up where it left off. Tasks, plans
and agent conversations are kept in its database (see
[The database](installation.md#the-database)); each task's transcript is saved in its project's
`.git/aso/` directory, so it never ends up in a commit or a worker's clone. On restart:

- **Started jobs** are held for 5 minutes, as if their worker had dropped off. The worker
  reconnects on its own, and its agent continues the same conversation.
- **Jobs not started yet** go back to the queue. This doesn't count as a node loss.
- **Hub-side steps** (verifying a push, merging) run again.
- **Plans** the Architect was working on are planned again; proposed plans still wait for
  approval.

Without a database, the tasks and plans are in each project's `.git/aso/state.json` and the
conversations in `~/aso-projects/.aso/`. Delete a project's `.git/aso/` while the Hub is
stopped to start that project with an empty task list. A state file the Hub can't read is
renamed to `state.json.unreadable-<time>` and the Hub starts empty.

**The acceptance check.** Passing tests show the code runs, not that it does what the task
asked. So after QA passes, the Architect's model reads the task, its acceptance criteria and the
diff, and judges each criterion *met*, *unmet* or *unclear*. If any is unmet, the task goes back
to its agent with what's missing (a rework round). Otherwise it moves on to review or merge, and
the verdict, criterion by criterion, goes into the pull request. If the check can't decide (no
model, a model error), the work moves on with a note. It costs one short call per round (a few
cents with Opus), counted in the task's cost; `--no-acceptance-check` turns it off.

- **Missing tests are unmet.** A criterion that asks for tests, or for a file to be added or
  changed, is *unmet* when the diff has no such change: the diff does show that. *Unclear* is
  for what it can't show, such as code outside the diff.
- **Quality notes, which never block.** The check also notes concrete problems besides the
  criteria, up to five: duplicated code, dead code, a summary that claims what the diff doesn't
  do, and existing tests weakened or removed. They go into the pull request, the console's task
  page (*Acceptance check*) and the task's history, and track records count them per model
  (*quality notes*), so a model that passes but cuts corners shows up.

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

For the scoring formula, see [ARCHITECTURE.md](../ARCHITECTURE.md#6-hardware-aware-routing).
