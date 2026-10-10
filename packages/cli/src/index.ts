#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HUB_PORT,
  WORKER_ROLES,
  WorkerRoleSchema,
  type WorkerRole,
} from "@aso/shared";
import type { Effort } from "@aso/hub";
import { llmCheckCommand } from "./commands/llm-check.js";
import { approvePlanCommand, planCommand, rejectPlanCommand } from "./commands/plan.js";
import { startHubCommand } from "./commands/start-hub.js";
import { startWorkerCommand } from "./commands/start-worker.js";
import { updateCommand } from "./commands/update.js";

const pkg = createRequire(import.meta.url)("../package.json") as { name: string; version: string };

// Settings such as ANTHROPIC_API_KEY can live in <aso>/.env (git-ignored). Variables already set
// in the shell take precedence over the file.
const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

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

function parseUsd(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive number of USD");
  return n;
}

function parseEffort(value: string): Effort {
  if (!EFFORTS.includes(value as Effort)) throw new InvalidArgumentError(`expected one of: ${EFFORTS.join(", ")}`);
  return value as Effort;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

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
  .option(
    "--allow-deps <list>",
    "comma-separated npm packages agents may request (`@scope/*` allows a scope); default: any",
    process.env.ASO_ALLOW_DEPS || undefined,
  )
  .option("--model <id>", "Claude model for agents", process.env.ASO_MODEL || "claude-opus-5-5")
  .option("--effort <level>", `model effort: ${EFFORTS.join(", ")}`, parseEffort, (process.env.ASO_EFFORT as Effort) || "high")
  .option("--task-budget <usd>", "estimated LLM spend cap per task", parseUsd, Number(process.env.ASO_TASK_BUDGET) || 5)
  .option("--llm-concurrency <n>", "concurrent model requests", parsePort, Number(process.env.ASO_LLM_CONCURRENCY) || 2)
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
  .command("plan")
  .description("Ask the Architect to plan a requirement, review the proposed tasks, and approve them")
  .argument("[requirement...]", "what to build (or use --file)")
  .option("-f, --file <path>", "read the requirement from a file")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("-y, --yes", "approve the proposed plan without asking", false)
  .action((words: string[], opts) => planCommand(words, opts));

program
  .command("plan-approve")
  .description("Approve a proposed plan: its tasks are created and start running")
  .argument("<planId>")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(approvePlanCommand);

program
  .command("plan-reject")
  .description("Reject a proposed plan")
  .argument("<planId>")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(rejectPlanCommand);

program
  .command("llm-check")
  .description("Send one tiny request to verify ANTHROPIC_API_KEY and model access (costs a fraction of a cent)")
  .option("--model <id>", "model to check", process.env.ASO_MODEL || "claude-opus-5-5")
  .action(llmCheckCommand);

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
