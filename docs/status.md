# Status

What's built, phase by phase.

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
| 17 | Any model: providers added with just a key (Anthropic, OpenAI, OpenRouter, Gemini, Groq, Mistral, Ollama or any OpenAI-compatible API) with model lists from their APIs, a model per desk, prices you can set, an acceptance check against each task's definition of done, and escalation of a failing task to a stronger model | ✅ Done |
| 18 | Machines anywhere: workers find the Hub over Tailscale too; a worker gateway for machines on the internet (worker keys only, through a TLS tunnel such as Tailscale Funnel); worker keys limited to projects, trust and a model budget; a track record per machine; invites from the console; a volunteer machine's own model serving its own jobs for free; Docker kept tidy | ✅ Done |

The whole loop runs end to end: you describe a requirement, the Architect plans it with you,
and each task is routed to the best free machine. An agent there explores and edits the code
and verifies its work. The Hub checks the push, QA tests it (on another machine when one is
free), and the agent reworks it if needed. You review the pull request, from your phone if you
like, and a project with a deploy command is deployed after the merge. Agents need at least one model provider on the Hub, such as an
Anthropic or OpenAI key or a local Ollama; see [Providers](models.md#providers).
