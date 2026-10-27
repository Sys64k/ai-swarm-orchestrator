# Configuration

Settings in `~/.config/aso/.env` and the environment.

| Variable | Default | Description |
|---|---|---|
| `ASO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ASO_TOKEN` | token file | The shared ASO token (workers, CLI). The Hub reads/creates `~/.config/aso/token` when unset |
| `ASO_HUB` | `127.0.0.1` | Default Hub address for `aso plan`, `sync`, `update` |
| `ASO_GIT_TOKEN` | *(none)* | Hub only: token for pushing to an HTTPS `origin` (e.g. GitHub fine-grained token) |
| `ASO_PUSH` | `1` | `0` keeps merges local (same as `--no-push`) |
| `ASO_CONFIG_DIR` | `~/.config/aso` | Where the token file and `.env` live |
| `ASO_DATABASE_URL` | *(none)* | Hub only: its PostgreSQL database (same as `--database-url`). With `--docker` and none set, the Hub's own database container; its password is kept in `~/.config/aso/db-password`. See [The database](installation.md#the-database) |
| `ASO_ENV_FILE` | *(none)* | An extra `.env` file to load (highest priority after the shell) |
| `ASO_TEST_COMMAND` | `npm test` | Default for `--test-command` (also passed into the container) |
| `ASO_QA` | `1` | `0` disables QA (same as `--no-qa`) |
| `ASO_AUTO_UPDATE` | `1` | `0` stops the Hub from updating outdated workers itself |
| `ASO_PULL_REQUESTS` | `1` | `0` merges QA-approved work on the Hub instead of opening GitHub pull requests |
| `ASO_ALLOW_DEPS` | *(any)* | Default for `--allow-deps` (also passed into the container) |
| `ASO_CONSOLE_URL` | *(none)* | Default for `--console-url` (also passed into the container) |
| `ANTHROPIC_API_KEY` | *(none)* | Hub only. Without it, agents fail tasks with "no LLM configured" |
| *(file)* `.env` | — | Loaded on start: the shell's variables win, then `ASO_ENV_FILE`, then `~/.config/aso/.env`, then a source checkout's `.env`. See `.env.example` |
| `ASO_MODEL`, `ASO_AGENT_MODEL`, `ASO_EFFORT`, `ASO_TASK_BUDGET`, `ASO_PLAN_BUDGET`, `ASO_MAX_TURNS`, `ASO_LLM_CONCURRENCY`, `ASO_ESCALATE_TO`, `ASO_JUNIOR_TRIES`, `ASO_ESCALATION` (`0`: off), `ASO_GATEWAY_PORT`, `ASO_GATEWAY_HOST`, `ASO_GATEWAY_URL`, `ASO_DOCKER_CLEANUP` (`0`: off), `ASO_AUTO_MERGE_SYNCS` (`0`: off), `ASO_PUBLIC_STATS`, `ASO_PUBLIC_STATS_PROJECTS` | see flags | Defaults for the LLM flags (also passed into the container) |
| `ASO_PUSH_CONTACT` | project URL | Contact (`mailto:` or `https:`) sent to push services with notifications (VAPID `sub`) |
| `ASO_UPDATE_SPEC` | `@aso/cli@latest` | Default source for `aso update` |
