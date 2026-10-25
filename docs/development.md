# Development

Working on ASO itself: building, testing and packaging.

```
packages/
  shared/     Zod protocol, agent tool schemas, role policies, plan validation, helpers
  hub/        Hono server, registry, router, tasks, plans, LLM gateway, Git endpoint + repo
  architect/  Architect node: plans requirements with read-only tools
scripts/package.mjs              Builds the distributable package (served by the Hub)
  worker/     hardware profiler, WebSocket client, job runner, AgentGitClient
  cli/        Commander.js `aso` command
  dashboard/  Next.js App Router UI
Dockerfile, docker-compose.yml   Hub image (used by `aso start-hub --docker`)
```

```bash
npm run build            # tsc -b (project references)
npm run build:dashboard  # next build (standalone server)
npm run package          # bundle the CLI (esbuild) + dashboard into release/aso.tgz
npm test                 # build + node:test (native TypeScript stripping, no extra deps)
```

The tests run against real git repositories and a real Hub on random ports. The pipeline suite
starts real workers that implement a task, fail QA, rework, pass and merge.

Tests that talk to the in-process Hub over HTTP must use async git (`gitAsync`). A synchronous
`execFileSync` would block the event loop the Hub needs to answer, and the test deadlocks.
