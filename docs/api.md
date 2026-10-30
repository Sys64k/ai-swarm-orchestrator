# Hub API

The Hub's HTTP endpoints. The full description, with request and response schemas, is the OpenAPI document [docs/openapi.json](openapi.json).

## Hub endpoints

The full description is **OpenAPI 3.1**: every Hub serves it at `/api/openapi.json` (no token
needed), and [`docs/openapi.json`](openapi.json) is the same document in this repository.
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
| `GET` | `/api/public-stats` | The swarm's track record as the Hub shares it, for anyone (404 unless started with `--public-stats`) |
| `GET` | `/api/track-records` | How models, machines, desks, roles, projects or task levels have done with their jobs (`?by=`, `project`, `role`, `level`, `model`: only that model's work, `since`, `until`: one period of a trend) |
| `GET` | `/api/model-suggestions` | Which model each role would do as well on for less, or clearly better on (`?since=`, default the last 30 days) |
| `POST` | `/api/models/roles` | Put the Architect or the reviewer (the acceptance check) on a model (`{ role, model }`), or back on `default` |
| `POST` | `/api/models/challengers` | Put a model on trial for the desks or the reviewer (`{ role, model, share?, budgetUsd? }`), end one (`end: true`), or all with `model: "none"` |
| `GET` / `POST` | `/api/tuning` | Each role's model pool, auto-tuning and its log / turn auto-tuning on or off and set the models to try (`{ role, auto?, candidates? }`) |
| `POST` | `/api/models/escalation` | Change where failing tasks move (`{ ladder?, juniorTries? }`, each a value or `default`) while the Hub runs |
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
| `POST` | `/api/tasks/:id/dismiss` | Done with a failed or cancelled task: it leaves Needs you and the failed count (a retry brings it back) |
| `POST` | `/api/tasks/:id/retry` | Queue a failed or cancelled task again with fresh limits and budget; an optional `{ description, acceptanceCriteria }` corrects it first |
| `GET` | `/api/push` | Push notifications: the Hub's public key (`applicationServerKey`) and how many devices are subscribed |
| `POST` | `/api/push/subscriptions`, `/check`, `/delete` | Add a device's `PushSubscription` (https endpoint, `p256dh`, `auth`), ask whether one is subscribed, remove one |
| `POST` | `/api/push/test` | Send a test notification, to `{ "endpoint" }` or every device |
| `POST` | `/api/sign-in-codes`, `/api/sign-in-codes/redeem` | Create a one-time console sign-in code (10 minutes, single use) / use one up. The console redeems codes server-side |
| `POST` | `/api/plans` | Start a plan: `{ "requirement": "..." }` → `201` with `planId` |
| `GET` | `/api/plans`, `/api/plans/:id` | Plans with state, summary, proposed tasks, cost |
| `POST` | `/api/plans/:id/approve` / `reject` | Decide on a proposed plan; approve returns the created task ids. Plans with questions can be rejected too |
| `POST` | `/api/plans/:id/reply` | `{ "message" }`: answer the Architect's questions (`awaiting_input`) or ask for changes to a `proposed` plan; it is planned again. `409` in other states or after 10 replies |
| `POST` | `/api/tasks` | Submit a task: `role`, `title`, `description`, optional `kind`, `taskId`, `acceptanceCriteria`, `files`, `dependsOn` (existing task ids), `level` (how hard, 1 to 5, for track records), `model` (every build on this model: no escalation or trial), `testsFirst` (the Architect's model writes the tests first, the builder makes them pass without changing them: see [Tests first](using-aso.md#tests-first)). Returns `201`, `400` (validation, or a model the Hub doesn't know) or `409` (duplicate id) |
| `GET` (WS) | `/ws` | Agent WebSocket endpoint (see [protocol](../ARCHITECTURE.md#4-communication-protocol)) |
| Git | `/git/<project>.git` | Clone and fetch a project. Pushes are limited to creating or updating `task/<id>` branches |
