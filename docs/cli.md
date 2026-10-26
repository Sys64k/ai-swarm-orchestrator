# CLI reference

Every `aso` command and its options.

## `aso start-hub`

| Option | Default | Description |
|---|---|---|
| `-r, --root <dir>` | `~/aso-projects` (`ASO_PROJECTS_ROOT`) | Folder of projects; each git repository in it is a project, and new ones are created there. Created if missing |
| `--docker` | off | Run the Hub and dashboard in Docker; the Architect stays on the host |
| `-p, --port <port>` | `7420` | Hub API, WebSocket and Git port |
| `--host <host>` | `0.0.0.0` | Interface to bind (in Docker mode: the published-port bind address) |
| `--dashboard-port <port>` | `7421` | Dashboard port |
| `--test-command <cmd>` | `npm test` | QA command, split on spaces, run without a shell |
| `--no-qa` | | Merge verified work without a QA run |
| `--no-acceptance-check` | | Don't check QA-passed work against its acceptance criteria (see [How a task flows](using-aso.md#how-a-task-flows)) |
| `--no-push` | | Keep merges local (don't push `main` to `origin`) |
| `--allow-deps <list>` | any | npm packages agents may request; `@scope/*` allows a scope |
| `--console-url <url>` | *(none)* | The console's address. Pull requests then link to their task, e.g. for its QA screenshots |
| `--model <spec>` | `claude-opus-5-5` when Anthropic is a [provider](models.md#providers); otherwise required | The Architect's model, and agents' without `--agent-model`: `<provider>/<model>` |
| `--escalate-to <specs>` | `--model` | Stronger models (comma-separated, weakest first) a task moves to after its junior tries; see [Escalation](models.md#escalation) |
| `--junior-tries <n>` | `2` | Tries a task gets on its desk's model before it escalates, counting the first attempt (2: the first attempt and one rework) |
| `--no-escalation` | | Keep every round on the desk's model |
| `--agent-model <spec>` | `--model` | The builder and QA agents' model. The Architect keeps `--model`: a strong planner breaking work into small, clear tasks lets a cheaper model build them |
| `--effort <level>` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--task-budget <usd>` | `5` | Estimated LLM spend cap per task |
| `--plan-budget <usd>` | `3` | Estimated LLM spend cap per planning round |
| `--max-turns <n>` | `80` | Model turns per task attempt or planning round. The agent is told to wrap up in its last 10; if it is still cut off, its unfinished work is pushed to the task branch for a retry |
| `--llm-concurrency <n>` | `4` | Concurrent model requests across all workers and the Architect; jobs beyond it wait their turn |
| `--no-dashboard` | | Skip the dashboard (not supported with `--docker`) |
| `--no-architect` | | Do not start the Architect |
| `--discovery-port <port>` | `7419` | UDP port this machine answers workers' [LAN discovery](installation.md#finding-the-hub-on-the-lan) on |
| `--no-discovery` | | Don't answer LAN discovery: workers then need `--hub` |
| `--gateway-port <port>` | off | Also listen here for workers coming from the internet through a TLS tunnel: only the worker connection, Git, the package and joining, worker keys only. See [Workers anywhere](installation.md#workers-anywhere) |
| `--gateway-host <host>` | `127.0.0.1` | Interface the worker gateway listens on (the tunnel connects locally) |
| `--update-from <git-url>` | `ASO_UPDATE_FROM` | Keep the Hub on that ASO repository's `main` (see [Automatic Hub updates](installation.md#automatic-hub-updates)). Only for an installed package run as the Hub service |

## `aso start-worker`

Profiles the machine (CPU, RAM, Docker, disk write speed) and connects to the Hub. A worker
doesn't choose what it works on: the Architect gives each task a role, and the Hub sends it to
the best free machine. If the
connection drops, the worker reconnects with exponential backoff. Without `--hub`, it asks the
LAN where the Hub is before each attempt, so it follows a Hub that moved. While offline it queues
outgoing messages and sends them once it has registered again.

| Option | Default | Description |
|---|---|---|
| `--hub <address>` | found on the LAN | `192.168.1.10`, `hub.lan:7420`, or `ws://…`. Without it, the worker [finds the Hub on the LAN](installation.md#finding-the-hub-on-the-lan) |
| `-p, --port <port>` | `7420` | Hub port, if `--hub` doesn't include one |
| `-w, --work-dir <path>` | `~/.aso/work` | Where the project checkouts live; the I/O benchmark runs here |
| `--slots <n>` | from the machine | Jobs to run at once, 1–16, each in its own checkout (`<project>`, `<project>.2`, …). The default is one per 2 threads and 6 GiB of RAM, at most 4, and 1 with `--sandbox none` (jobs would share ports) |
| `--token <token>` | `ASO_TOKEN` / worker key / token file | What to connect with (normally the machine's worker key) |
| `--join <code>` | | Join the Hub with a one-time code from `aso worker-key new`: the machine gets its own worker key |
| `--allow-insecure` | | Allow plain `ws://` to a Hub on the internet (refused otherwise) |
| `--sandbox <mode>` | `docker` | `docker`: each job command runs in a throwaway container that sees only the checkout. `none`: directly on this machine as this user. The worker refuses to start if `docker` is chosen but Docker isn't usable |
| `--sandbox-image <image>` | built on first start | Image for job commands. The default is `node:<worker's Node major>-bookworm` plus Playwright's Chromium libraries |
| `--sandbox-network <name>` | `bridge` | Docker network for job commands. `none` blocks all network access, but then `npm ci` and browser downloads fail |

## `aso service`

`aso service install [start-worker options]` installs and starts this machine's worker as a
systemd user service (see [Keep a worker running](installation.md#keep-a-worker-running-systemd)). The
other subcommands are `status`, `logs [-f] [-n <lines>]` and `uninstall`. Linux with systemd
only.

## `aso hub-service`

`aso hub-service install [start-hub options]` installs and starts the Hub as a systemd user
service (see [Keep the Hub running](installation.md#keep-the-hub-running-systemd)). The other subcommands
are `status`, `restart`, `logs [-f] [-n <lines>]` and `uninstall`. Linux with systemd only.

## `aso plan`

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

## `aso llm-check`

Sends three tiny requests: a one-word reply (the key, model access and credit balance), a
tool call, and a turn that answers the call, as an agent's next turn does (some APIs check that
turn, e.g. Gemini wants its thought signature back). Agents can't work without the last two.
Prints the reply, the tokens used and the estimated cost (a fraction of a cent). `--model <spec>` checks a different model from any
[provider](models.md#providers) (`openai/gpt-5`, `ollama/qwen3-coder:30b`); `--root` points at
the Hub's projects folder when it isn't the default.

## `aso token`

Prints the Hub's ASO token (from `ASO_TOKEN` or `~/.config/aso/token`). Give it to workers.

## `aso console-link`

Prints a one-time sign-in link for the console, and its QR code, to open on a phone or another
browser. The link works once, within 10 minutes.

| Option | Default | Description |
|---|---|---|
| `--url <base>` | Tailscale HTTPS address if `tailscale serve` proxies to the console, else the LAN address | Console address to put in the link |
| `--dashboard-port <port>` | `7421` | Console port, used to find the address |
| `--no-qr` | | Print only the link |
| `--hub <address>` | `127.0.0.1` | Hub that issues the code |

## `aso status`

The Hub at a glance in a terminal: the version it runs and where its own update stands, the
workers and what they do, and each project's work and last deploy. Exits with 1 when the Hub's
update or a project's last deploy failed, so scripts can check it. `--hub <address>` for another
machine's Hub.

## `aso deploy <project>`

Deploys the project's `main` now with its command from the Hub's `deploy.json`, follows it to
the end, and prints how it went: the commit and how long it took, or the reason and the last 30
lines of output (exit code 1). `--no-wait` only starts it. A project without a deploy command is
refused with the reason.

## `aso worker-key new|set|revoke`, `aso worker-keys`

`new` creates a one-time join code (30 minutes) and prints what to run on the new machine. On
the LAN, that machine finds the Hub with the code. `--address` is the Hub's address as that
machine reaches it, for downloading the package and for joining from another network (default:
this machine's hostname, which on Tailscale is its tailnet name). `--name` labels the key.

What the key may do (see [Machines you don't control](installation.md#machines-you-dont-control)):

| Option | Default | |
|---|---|---|
| `--projects <ids>` | all | Comma-separated projects it may clone and work on |
| `--untrusted` | trusted | Its machine only builds; a trusted machine tests its work |
| `--budget <usd>` | none | USD of model calls its jobs may cause in total |

`set <id>` changes them later: `--projects`, `--all-projects`, `--trusted`, `--untrusted`,
`--budget`, `--no-budget`. `aso worker-keys` lists the keys with what each may do and has
spent, and `revoke` shuts a machine out.

## `aso providers`, `aso provider add|remove`

`aso providers` lists the model providers (added ones and the `.env`'s) and how many models
each lists. `aso provider add <preset>` adds one: `anthropic`, `openai`, `openrouter`,
`gemini`, `groq`, `mistral` (they ask for the key at a hidden prompt, or read it from stdin;
`--key` works but lands in your shell history), or `ollama` / `custom` with `--url`. `--name`
gives a second one of a kind its own name; `--vision` marks models that accept images.
`aso provider remove <id>` forgets it and its key. See [Providers](models.md#providers).

## `aso prices`, `aso price set|remove`

`aso prices` lists the model prices the Hub knows (USD per million tokens): the built-in Claude
ones and those set on the Hub. `aso price set <model> --input <usd> --output <usd>
[--cache-read <usd>] [--cache-write <usd>]` sets one for `<provider>/<model>` or a model's
name, so task budgets stop that model too. It applies to that model name and wins over a
built-in or reported price. The cache rates default to the input price: give `--cache-read`,
since most of an agent's input is read from the cache. `aso price remove <model>` removes it.

## `aso models`, `aso desks`, `aso desk`

`aso models` lists the models desks can use, from every provider. `aso desks` shows
each desk with a model of its own, and each such model's calls at once and load.
`aso desk <host>#<slot>|<host> <model|default>` puts a desk, or every desk of a connected
machine, on a model (`--concurrency`, `--base-url`, `--vision`). See
[A model per desk](models.md#a-model-per-desk).

## `aso find-hub`

Asks the LAN and the Tailscale network where the Hub is, with this machine's worker key, prints
its `host:port`, and says whether it was found on the LAN or over Tailscale. `--join <code>`
asks with a join code instead. It fails with what to check when no Hub answers: whether
Tailscale runs here, and the firewall rule the Hub's machine needs for discovery over Tailscale.

## `aso sync`

Shows the push status for the target repository's remote, and retries a failed push. Run it
after resolving a conflict. `--hub <address>` selects the Hub.

## `aso update`

Updates this machine's `aso`:

- **Installed packages:** downloads the Hub's package if its version differs, checks its
  SHA-256, and installs it.
- **Source checkouts:** pulls and rebuilds.

Options:

- `--hub <address>`: the Hub to update from (default `ASO_HUB` or `127.0.0.1`).
- `--spec <npm spec>`: install that npm spec instead.
