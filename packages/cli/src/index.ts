#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HUB_PORT,
  WORKER_ROLES,
  WorkerRoleSchema,
  type WorkerRole,
} from "@aso/shared";
import { startHubCommand } from "./commands/start-hub.js";
import { startWorkerCommand } from "./commands/start-worker.js";
import { updateCommand } from "./commands/update.js";

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError("must be an integer between 1 and 65535");
  }
  return n;
}

function parseRoles(value: string): WorkerRole[] {
  const roles = value.split(",").map((r) => r.trim()).filter(Boolean);
  const invalid = roles.filter((r) => !WorkerRoleSchema.safeParse(r).success);
  if (!roles.length || invalid.length) {
    throw new InvalidArgumentError(`expected a comma-separated list of: ${WORKER_ROLES.join(", ")}`);
  }
  return [...new Set(roles)] as WorkerRole[];
}

const program = new Command()
  .name("aso")
  .description("AI Swarm Orchestrator - local-network multi-agent development swarm")
  .version(pkg.version);

program
  .command("start-hub")
  .description("Start the Hub: API/WebSocket server, dashboard and Architect tmux session")
  .requiredOption("-d, --dir <target_project_path>", "path to the target project repository")
  .option("-p, --port <port>", "Hub API/WebSocket port", parsePort, DEFAULT_HUB_PORT)
  .option("--host <host>", "interface to bind", "0.0.0.0")
  .option("--dashboard-port <port>", "dashboard port", parsePort, DEFAULT_DASHBOARD_PORT)
  .option("--no-dashboard", "do not launch the Next.js dashboard")
  .option("--no-architect", "do not launch the Architect tmux session")
  .option("--docker", "run the Hub and dashboard in Docker (Architect stays on the host)", false)
  .option(
    "--test-command <cmd>",
    "QA test command, split on spaces, run without a shell",
    process.env.ASO_TEST_COMMAND || "npm test",
  )
  .option("--no-qa", "merge verified work without a QA run")
  .action(startHubCommand);

program
  .command("start-worker")
  .description("Start a Worker node: scan hardware and connect to the Hub")
  .requiredOption("--hub <ip_address>", "Hub address (IP, host:port, or ws:// URL)")
  .option("-p, --port <port>", "Hub port if not given in --hub", parsePort, DEFAULT_HUB_PORT)
  .option("-r, --roles <roles>", `roles to accept (default: ${WORKER_ROLES.join(",")})`, parseRoles)
  .option("-w, --work-dir <path>", "directory for task checkouts (default: ~/.aso/work)")
  .action(startWorkerCommand);

program
  .command("update")
  .description("Install the latest version of the aso CLI globally")
  .option(
    "--spec <npm_spec>",
    "npm install spec to update from (registry name, git URL or tarball)",
    process.env.ASO_UPDATE_SPEC ?? `${pkg.name}@latest`,
  )
  .action((opts: { spec: string }) => updateCommand(opts.spec, pkg.version));

program.parseAsync().catch((err: unknown) => {
  console.error(`aso: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
