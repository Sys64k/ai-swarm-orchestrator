# Security

How ASO (Skynet) protects your projects and machines: the credentials it uses, what each part of
the swarm holds, how to revoke and rotate them, what limits a misbehaving agent, and what isn't
protected. [ARCHITECTURE.md](ARCHITECTURE.md) explains the mechanisms in more depth.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub's
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce
it and which version (`aso --version`) you ran.

## The credentials

| Credential | Looks like | Where it lives | What it allows | If it leaks |
|---|---|---|---|---|
| **Hub token** | `aso_…` | `~/.config/aso/token` on the Hub machine (mode 600), or `ASO_TOKEN` | Everything: plan, approve, merge, deploy, read every project, manage worker keys | Whoever has it controls the swarm: [rotate it](#rotating-the-hub-token) |
| **Worker key** | `asow_…` | `~/.config/aso/worker-key` on its worker (mode 600). The Hub keeps only its SHA-256 | Worker work only: the worker connection, fetching the projects' Git, pushing to task branches its own worker is implementing | [Revoke that key](#revoking-a-worker-key); other machines are unaffected |
| **Join code** | random text | Nowhere: shown once by `aso worker-key new` or the console | Traded once, within 30 minutes, for a new worker key | Expires and works once. Revoke the key it was traded for if a stranger used it |
| **Sign-in code** | `…/login?code=…` | Nowhere: made by `aso console-link` or *Sign in another device* | Signs one browser in to the core console or aso-ui, once, within minutes | Expires and works once |
| **GitHub token** | `github_pat_…` | `ASO_GIT_TOKEN` on the Hub machine | The Hub pushes `main`, opens and merges pull requests and reads CI checks | Revoke it on GitHub and set a new one |
| **Anthropic API key** | `sk-ant-…` | `ANTHROPIC_API_KEY` on the Hub machine only, or added as a provider | Model calls, which cost money | Revoke it in the Anthropic console and set a new one |
| **Provider keys** | `sk-…`, `sk-or-…`, … | `<projects root>/.aso/providers.json` on the Hub (mode 600), from `aso provider add`; or `OPENAI_API_KEY` etc. in the Hub's `.env` | Model calls at that provider, which may cost money | `aso provider remove <id>` (or delete it from the `.env` and restart); revoke it at the provider |

`ASO_TOKEN`, `ASO_GIT_TOKEN` and `ANTHROPIC_API_KEY` are read from the environment or from
`~/.config/aso/.env` (mode 600). Tokens are compared in constant time.

## Who holds what

**The Hub token stays on the Hub machine.** Everything else is limited to one job, works once,
or holds no secret.

- **You, on the Hub machine:** the `aso` CLI reads the Hub token from its file.
- **The Architect** runs on the Hub machine with the Hub token: it reads every requirement and
  writes the plans you approve.
- **Workers** hold only their own worker key (`aso service install --join <code>`). A worker
  machine doesn't need the Hub token; remove any old `ASO_TOKEN` from its `~/.config/aso/.env`.
  Model calls go through the Hub, so workers never hold the Anthropic key.
- **The core console** (the Hub's dashboard) runs on the Hub machine with the Hub token. A
  browser signs in with a one-time code (or by typing the token on its sign-in page) and gets a
  signed session cookie that contains no token. Scripts can still use HTTP Basic auth with the
  token.
- **aso-ui** holds the Hub token on its server only, from `~/.config/aso/aso-ui.env` (mode 600)
  passed to its container with `--env-file`. A browser signs in with a one-time code and gets a
  signed session cookie that contains no token. The token is never in its pages, links or
  cookies.
- **Deploy commands** run on the Hub machine with a reduced environment, without the Hub's tokens.

## Revoking and rotating

### Revoking a worker key

1. On the Hub machine, `aso worker-keys` lists the keys; `aso worker-key revoke <id>` (or
   **Revoke** in the console) disconnects that machine at once and keeps it out.
2. To let the machine back in, create a new join code (`aso worker-key new`) and run
   `aso service install --join <code>` on it. It saves its new key in place of the old one.

### Rotating the Hub token

1. On the Hub machine, delete `~/.config/aso/token` (and `ASO_TOKEN`, if it's set in
   `~/.config/aso/.env`), then restart the Hub: `aso hub-service restart`. It creates a new token.
2. Put the new token (`aso token`) in `~/.config/aso/aso-ui.env` as `ASO_TOKEN=…` and redeploy
   aso-ui (`aso deploy aso-ui`). Its sessions are signed with a key derived from the token
   (unless `ASO_SESSION_SECRET` is set), so every aso-ui browser is signed out.
3. Core console browsers are signed out too: their sessions are signed with a key derived from
   the token. Sign in again with `aso console-link`.
4. Workers with their own keys need nothing. A worker still using `ASO_TOKEN` needs a worker key
   (preferred) or the new token.

### Rotating the GitHub token or the Anthropic key

Revoke the old one at GitHub or Anthropic, set the new value in `~/.config/aso/.env`, and restart
the Hub (`aso hub-service restart`). `aso llm-check` confirms the Anthropic key.

## What protects what

### Credentials

- **No credential on a command line.** Git gets credentials from an owner-only config file
  (`-c include.path=<file>`), never as `-c http.extraHeader=…`, so other users on the machine
  can't read them with `ps`. The Hub's GitHub token goes only to the remote's host.
- **Worker keys are narrow.** A key can't register the Architect, can't take a node id another
  credential registered (also right after a Hub restart: owners are saved in
  `node-owners.json`), and runs one worker at a time. Its pushes must go to a task its own worker
  is implementing.
- **Joining is rate-limited.** Wrong join codes are slowed down per client address; a valid code
  always works, so a flood can't keep a machine out.

### The network

- **Plain HTTP by default.** On the LAN, traffic (the token, codes, jobs) is unencrypted. Use a
  trusted network, Tailscale, or a TLS reverse proxy (`wss://`) if the LAN isn't trusted.
- **No plain `ws://` to the internet.** Before every connection, a worker refuses a Hub address
  that resolves to a public IP unless it's `wss://` (`--allow-insecure` overrides).
  Private ranges, loopback and Tailscale's `100.64.0.0/10` count as private.
- **The worker gateway is the only part meant for the internet.** With `--gateway-port`, a
  second listener (on `127.0.0.1`, behind a TLS tunnel such as Tailscale Funnel) serves only
  the worker connection, Git, the package, `health`, `version` and joining. Everything else
  answers 404, and the main token is refused there, so the API, the console and everything a
  leaked token could do stay off the internet. A worker key there can do what it can anywhere:
  take jobs and use the projects' Git (clone any project, push only its own task branches). An
  address with 20 failed keys or join codes in 10 minutes is refused for 10 minutes.
- **A worker key can be limited** (`aso worker-key new|set`): to some projects (jobs and Git),
  to building only (`--untrusted`: QA, which runs the code, always runs on a trusted machine),
  and to a model budget its jobs may cause. Enforced on the Hub when it picks a machine for a
  job, on every Git request, and before every model call.
- **LAN discovery can't be spoofed into leaking a key.** A worker without `--hub` broadcasts a
  query (and sends it to each online Tailscale peer) that names its key by a hash, never the key. It connects only to an answer whose HMAC
  proof (made with the key's hash, which only the Hub holds) covers the worker's nonce, the port
  and the address the answer came from, and only from a private address. The Hub's machine
  answers at most 30 queries per 10 s and stays silent for a key it doesn't know.
- **Session cookies hold no token.** Both consoles sign their session cookie (HMAC-SHA256 with a
  key derived from the Hub token), so copying a browser's cookies gives access to that console
  until it expires or the token is rotated, never the token itself.
- **Session cookies follow HTTPS.** aso-ui marks its cookie Secure over HTTPS (also behind a
  proxy, via `X-Forwarded-Proto`), not over plain HTTP, so LAN sign-in works.

### Agents and their code

- **Job sandbox.** Every command a job runs gets a throwaway Docker container: agent
  `run_command`, `npm ci` with its install scripts, and QA setup and tests. The container:
  - sees only the task checkout, with `.git` read-only, so it can't plant hooks or config that
    the worker's own git would run on the host
  - sees a shared npm/browser cache, but not the home directory, SSH keys or the worker key
  - gets none of the worker's environment variables
  - runs as the worker's user, with no capabilities, no privilege escalation, a read-only root
    filesystem and a process limit

  It has network access by default (`bridge`), which npm and browser downloads need, so it can
  reach your LAN, though not the Hub's API or Git without a credential. It can't use Docker, so
  DevOps agents can write Dockerfiles but can't build them on a worker. `--sandbox none` turns
  all of this off.
- **Agent tools are guardrails, not a boundary.** Paths are confined to the checkout (also
  through symlinks), protected files are refused, and `git`, shells, `sudo` and package installs
  are blocked in `run_command`. These checks go by program name (`node -e` can start anything);
  what contains a misbehaving agent is the sandbox.
- **Only the Hub writes `main`.** The Git endpoint refuses pushes to `main`, tags, deletions and
  anything outside `refs/heads/task/<id>`.
- **Checks on both sides.** Workers refuse to commit `package.json` or lockfiles, and the Hub
  checks again before QA, so a misbehaving worker can't get around it.
- **Dependencies.** On the Hub, installs never execute package code
  (`--package-lock-only --ignore-scripts`). Agents still choose *which* packages get added, and
  workers run install scripts during `npm ci` (in the sandbox). `--allow-deps` limits which
  packages agents may request.
- **Message validation.** All WebSocket traffic is validated against strict Zod schemas: unknown
  fields are rejected, paths can't escape the repository, dependency requests accept only registry
  package names and semver ranges, and nodes can't supply their own system prompts.
- **Test commands** come from the Hub's configuration, never from workers. They run without a
  shell, in their own process group, with a timeout.
- **People review before `main` changes** when pull requests are on: QA-approved work becomes a
  pull request, and the Hub merges only what you approve.

### Deploys

Deploy commands come only from the operator, in `<projects root>/.aso/deploy.json`, never from a
project's repository, which agents change. They run on the Hub machine, with a reduced
environment, after the merge you approved. Prefer commands that build in containers
(`docker build`) over running project scripts directly on the host.

## Known limits

- **Plain HTTP on the LAN** unless you use Tailscale or a TLS proxy (above).
- **`--sandbox none`** runs job commands directly as the worker's user, so they can read the
  worker key and anything else that user can.
- **`--docker` passes the Anthropic key into the Hub container's environment**, so anyone who can
  run `docker inspect` on the Hub machine can read it. Members of the `docker` group are
  effectively root anyway.
- **`100.64.0.0/10`** counts as private for Tailscale, but carrier-grade NAT uses it too.
- **A killed process can leave its credential file behind** (owner-only, in a private folder
  under the temp directory).
- **The GitHub token's reach is what you grant it.** Use a fine-grained token limited to the
  project repositories, with only *Contents* and *Pull requests* write access (and *Actions*
  read for CI checks).
