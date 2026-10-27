#!/usr/bin/env node
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { DEFAULT_JUNIOR_TRIES } from "@aso/hub";
import {
  resolveToken,
  tokenFile,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_DISCOVERY_PORT,
  isProviderPreset,
  PROVIDER_PRESETS,
  DEFAULT_HUB_PORT,
  DEFAULT_PROJECTS_DIR,
  MAX_JUNIOR_TRIES,
  MAX_WORKER_SLOTS,
  TRACK_RECORD_KEYS,
} from "@aso/shared";
import type { Effort } from "@aso/hub";
import { startArchitect } from "@aso/architect";
import { consoleLinkCommand } from "./commands/console-link.js";
import { llmCheckCommand } from "./commands/llm-check.js";
import { syncCommand } from "./commands/sync.js";
import { deployCommand, statusCommand } from "./commands/status.js";
import { listWorkerKeysCommand, newWorkerKeyCommand, setWorkerKeyCommand, revokeWorkerKeyCommand } from "./commands/worker-keys.js";
import { layout } from "./layout.js";
import { approvePlanCommand, planCommand, rejectPlanCommand, replyPlanCommand } from "./commands/plan.js";
import { startHubCommand } from "./commands/start-hub.js";
import {
  installHubServiceCommand,
  installServiceCommand,
  logsHubServiceCommand,
  logsServiceCommand,
  restartHubServiceCommand,
  statusHubServiceCommand,
  statusServiceCommand,
  uninstallHubServiceCommand,
  uninstallServiceCommand,
} from "./commands/service.js";
import { startWorkerCommand } from "./commands/start-worker.js";
import { findHubCommand } from "./commands/find-hub.js";
import { deskCommand, desksCommand, escalationCommand, modelsCommand } from "./commands/models.js";
import { trackRecordsCommand } from "./commands/track-records.js";
import { addProviderCommand, providersCommand, removeProviderCommand } from "./commands/providers.js";
import { pricesCommand, removePriceCommand, setPriceCommand } from "./commands/prices.js";
import { updateCommand } from "./commands/update.js";
import { rollbackUnconfirmed, updatePaths } from "./self-update.js";
import { userTool } from "./systemd.js";
import { HUB_SERVICE } from "./service.js";

// Settings such as ANTHROPIC_API_KEY can live in a .env file (see layout.envFiles(): ASO_ENV_FILE,
// ~/.config/aso/.env, or the source checkout's .env). Shell variables take precedence, then the
// files in order.
for (const file of layout.envFiles()) {
  if (!existsSync(file)) continue;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    // A broken file must not stop every command, the update watchdog's rollback included.
    console.error(`aso: could not read ${file}: ${(err as Error).message}`);
  }
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError("must be an integer between 1 and 65535");
  }
  return n;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("must be a whole number of 1 or more");
  return n;
}

function parseSlots(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WORKER_SLOTS) {
    throw new InvalidArgumentError(`must be a whole number from 1 to ${MAX_WORKER_SLOTS}`);
  }
  return n;
}

/** A wss:// address (the worker gateway's, as machines on the internet reach it). */
function parseWssUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("expected a wss:// address, e.g. wss://agent007.tailc9777f.ts.net:10000");
  }
  if (url.protocol !== "wss:") throw new InvalidArgumentError("must start with wss:// (machines on the internet only connect over TLS)");
  return value.replace(/\/+$/, "");
}

/** A whole number, 0 or more (e.g. rounds). */
function parseCount(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_JUNIOR_TRIES) throw new InvalidArgumentError(`expected a whole number from 0 to ${MAX_JUNIOR_TRIES}`);
  return n;
}

/** `--junior-tries` of `aso escalation`: a count, or `default`. */
function parseTriesOrDefault(value: string): number | "default" {
  return value === "default" ? value : parseCount(value);
}

function parseUsd(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive number of USD");
  return n;
}

function parseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidArgumentError("must be a URL, e.g. https://hub.example.ts.net");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new InvalidArgumentError("must be an http(s) URL");
  return value.replace(/\/+$/, "");
}

function parseEffort(value: string): Effort {
  if (!EFFORTS.includes(value as Effort)) throw new InvalidArgumentError(`expected one of: ${EFFORTS.join(", ")}`);
  return value as Effort;
}

function parseSandbox(value: string): "docker" | "none" {
  if (value !== "docker" && value !== "none") throw new InvalidArgumentError("expected docker or none");
  return value;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const program = new Command()
  .name("aso")
  .description("Skynet (AI Swarm Orchestrator) - local-network multi-agent development swarm")
  .version(layout.version());

/** The Hub's projects folder unless --root says otherwise. */
const DEFAULT_ROOT = process.env.ASO_PROJECTS_ROOT || path.join(os.homedir(), DEFAULT_PROJECTS_DIR);

/** Options shared by `start-hub` and `hub-service install` (the service runs start-hub with the ones given). */
function hubOptions(cmd: Command): Command {
  return cmd
    .option(
      "-r, --root <dir>",
      "folder of projects: each git repository in it is a project, and new ones are created there",
      DEFAULT_ROOT,
    )
    .option("-p, --port <port>", "Hub API/WebSocket port", parsePort, DEFAULT_HUB_PORT)
    .option("--host <host>", "interface to bind", "0.0.0.0")
    .option("--dashboard-port <port>", "dashboard port", parsePort, DEFAULT_DASHBOARD_PORT)
    .option("--no-dashboard", "do not launch the Next.js dashboard")
    .option("--no-architect", "do not launch the Architect")
    .option("--discovery-port <port>", "UDP port this machine answers workers' LAN discovery on (workers started without --hub)", parsePort, DEFAULT_DISCOVERY_PORT)
    .option(
      "--gateway-port <port>",
      "also listen here for workers coming in from the internet through a TLS tunnel (e.g. Tailscale Funnel): only the worker connection, Git, the package and joining, worker keys only",
      parsePort,
      process.env.ASO_GATEWAY_PORT ? Number(process.env.ASO_GATEWAY_PORT) : undefined,
    )
    .option("--gateway-host <host>", "interface the worker gateway listens on (the tunnel connects locally)", process.env.ASO_GATEWAY_HOST || "127.0.0.1")
    .option(
      "--public-stats <parts>",
      "share the swarm's track record publicly at /api/public-stats (and on the worker gateway), for a README: totals, plus `models` and/or `costs` (comma-separated, or `totals` for totals only)",
      process.env.ASO_PUBLIC_STATS || undefined,
    )
    .option("--public-stats-projects <names>", "only these projects' work in the public stats (comma-separated; default: all)", process.env.ASO_PUBLIC_STATS_PROJECTS || undefined)
    // No default here: help output would show the URL (and its password) from ASO_DATABASE_URL.
    .option("--database-url <url>", "keep tasks, plans and conversations in this PostgreSQL database (default: ASO_DATABASE_URL; with --docker, a database container of its own)")
    .addOption(
      new Option("--no-auto-merge-syncs", "leave API sync pull requests for a person even when QA, every acceptance criterion and CI pass").default(
        process.env.ASO_AUTO_MERGE_SYNCS !== "0",
      ),
    )
    .addOption(
      new Option("--no-docker-cleanup", "don't tidy Docker after Hub updates and deploys (old build cache, dangling images, old project images)").default(
        process.env.ASO_DOCKER_CLEANUP !== "0",
      ),
    )
    .option("--gateway-url <url>", "the worker gateway's public wss:// address (e.g. wss://agent007.tailc9777f.ts.net:10000), for join commands", parseWssUrl, process.env.ASO_GATEWAY_URL || undefined)
    .option("--no-discovery", "do not answer LAN discovery: workers need --hub")
    .option("--docker", "run the Hub and dashboard in Docker (Architect stays on the host)", false)
    .option("--test-command <cmd>", "QA test command, split on spaces, run without a shell", process.env.ASO_TEST_COMMAND || "npm test")
    .option("--no-qa", "merge verified work without a QA run")
    .option("--no-acceptance-check", "don't check QA-passed work against its acceptance criteria with the Architect's model")
    .option("--no-push", "keep merges local instead of pushing main to the target repo's origin")
    .option(
      "--allow-deps <list>",
      "comma-separated npm packages agents may request (`@scope/*` allows a scope); default: any",
      process.env.ASO_ALLOW_DEPS || undefined,
    )
    .option("--console-url <url>", "the console's address, for links from pull requests to their tasks (e.g. QA screenshots)", parseUrl, process.env.ASO_CONSOLE_URL || undefined)
    .option("--model <spec>", "the Architect's model, and agents' without --agent-model: <provider>/<model> (see aso models); default: Claude Opus when Anthropic is a provider", process.env.ASO_MODEL || undefined)
    .option("--agent-model <spec>", "the builder and QA agents' model (default: --model)", process.env.ASO_AGENT_MODEL || undefined)
    .option("--escalate-to <specs>", "stronger models (comma-separated, weakest first) a task moves to after failing rounds on its desk's model (default: --model)", process.env.ASO_ESCALATE_TO || undefined)
    .option("--junior-tries <n>", "tries a task gets on its desk's model before it escalates, counting the first attempt (2: the first attempt and one rework)", parseCount, process.env.ASO_JUNIOR_TRIES ? Number(process.env.ASO_JUNIOR_TRIES) : DEFAULT_JUNIOR_TRIES)
    .addOption(new Option("--no-escalation", "keep every round on the desk's model").default(process.env.ASO_ESCALATION !== "0"))
    .option("--effort <level>", `model effort: ${EFFORTS.join(", ")}`, parseEffort, (process.env.ASO_EFFORT as Effort) || "high")
    .option("--task-budget <usd>", "estimated LLM spend cap per task", parseUsd, Number(process.env.ASO_TASK_BUDGET) || 5)
    .option("--plan-budget <usd>", "estimated LLM spend cap per planning round", parseUsd, Number(process.env.ASO_PLAN_BUDGET) || 3)
    .option("--max-turns <n>", "model turns per agent round (task attempt or planning round)", parsePort, Number(process.env.ASO_MAX_TURNS) || 80)
    .option("--llm-concurrency <n>", "concurrent model requests", parsePort, Number(process.env.ASO_LLM_CONCURRENCY) || 4)
    .option(
      "--update-from <git-url>",
      "keep this Hub on that ASO repository's main: build and test each new commit, install it when the swarm is idle, roll back if it doesn't come up (an installed package run as the Hub service)",
      process.env.ASO_UPDATE_FROM || undefined,
    );
}

hubOptions(program.command("start-hub").description("Start the Hub: API/WebSocket server, dashboard and Architect"))
  .action(startHubCommand);

/**
 * Options shared by `start-worker` and `service install` (the service runs start-worker with
 * them). A new option here also needs `WorkerServiceOptions` and `workerArgs` in service.ts.
 */
function workerOptions(cmd: Command): Command {
  return cmd
    .option("--hub <ip_address>", "Hub address (IP, host:port, or ws:// URL); without it, the Hub is found on the LAN, again whenever its address changes")
    .option("-p, --port <port>", "Hub port if not given in --hub", parsePort, DEFAULT_HUB_PORT)
    .option("-w, --work-dir <path>", "directory for task checkouts (default: ~/.aso/work)")
    .option("--slots <n>", "jobs to run at once (default: from cores and RAM, at most 4; 1 with --sandbox none)", parseSlots)
    .option("--token <token>", "ASO token from the Hub (default: ASO_TOKEN, this machine's worker key, or the local token file)")
    .option("--join <code>", "join the Hub with a one-time code from `aso worker-key new` (or its console): this machine gets its own worker key")
    .option("--allow-insecure", "allow plain ws:// to a Hub on the internet (unencrypted)", false)
    .option(
      "--sandbox <mode>",
      "where job commands run: docker (a container per command that sees only the checkout) or none (directly on this machine)",
      parseSandbox,
      "docker",
    )
    .option("--sandbox-image <image>", "Docker image for job commands (default: built on first start)")
    .option("--sandbox-network <name>", "docker network for job commands (default: bridge; `none` blocks network access)")
    .option(
      "--local-model <url>",
      "this machine's own model server (OpenAI-compatible, e.g. Ollama's http://localhost:11434/v1): the Hub uses its models for this machine's jobs, at no cost to the Hub",
      process.env.ASO_LOCAL_MODEL_URL || undefined,
    )
    .option("--local-model-name <id>", "which of its models this machine's desks use (default: the first it lists)")
    .option("--local-model-vision", "its models accept images");
}

workerOptions(program.command("start-worker").description("Start a Worker node: scan hardware and connect to the Hub")).action(startWorkerCommand);

const hubServiceCmd = program
  .command("hub-service")
  .description("Run this machine's Hub as a systemd user service (starts at boot, restarts on failure)");
hubOptions(hubServiceCmd.command("install").description("Install and start the Hub service with these start-hub options")).action(
  installHubServiceCommand,
);
hubServiceCmd.command("uninstall").description("Stop and remove the Hub service").action(uninstallHubServiceCommand);
// Run by the watchdog an update arms (from the version before it): roll back an update that never confirmed.
program
  .command("hub-update-check", { hidden: true })
  .option("--id <id>", "the update the timer was armed for")
  .option("--at-start", "run before the service starts: roll back only an update past its deadline", false)
  .action(async (opts: { id?: string; atStart: boolean }) => {
    await rollbackUnconfirmed(updatePaths(), opts, () => {
      const r = userTool("systemctl", ["restart", HUB_SERVICE]);
      if (!r.ok) throw new Error(`could not restart ${HUB_SERVICE}: ${r.output}`);
    });
  });
hubServiceCmd.command("status").description("Show whether the Hub service is running").action(statusHubServiceCommand);
hubServiceCmd.command("restart").description("Restart the Hub service (after rebuilding or updating aso)").action(restartHubServiceCommand);
hubServiceCmd
  .command("logs")
  .description("Show the Hub service's log")
  .option("-f, --follow", "keep printing new lines", false)
  .option("-n, --lines <n>", "lines to show", "100")
  .action(logsHubServiceCommand);

const serviceCmd = program.command("service").description("Run this machine's worker as a systemd user service (starts at boot, restarts on failure)");
workerOptions(serviceCmd.command("install").description("Install and start the worker service with these start-worker options")).action(installServiceCommand);
serviceCmd.command("uninstall").description("Stop and remove the worker service").action(uninstallServiceCommand);
serviceCmd.command("status").description("Show whether the worker service is running").action(statusServiceCommand);
serviceCmd
  .command("logs")
  .description("Show the worker service's log")
  .option("-f, --follow", "keep printing new lines", false)
  .option("-n, --lines <n>", "lines to show", "100")
  .action(logsServiceCommand);

program
  .command("plan")
  .description("Ask the Architect to plan a requirement, review the proposed tasks, and approve them")
  .argument("[requirement...]", "what to build (or use --file)")
  .option("-f, --file <path>", "read the requirement from a file")
  .option("-P, --project <name>", "project to plan for (needed when the Hub has more than one)", process.env.ASO_PROJECT || undefined)
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
  .command("plan-reply")
  .description("Answer the Architect's questions, or ask for changes to a proposed plan (it plans again)")
  .argument("<planId>")
  .argument("<message...>", "your answers or the changes you want")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(replyPlanCommand);

program
  .command("plan-reject")
  .description("Reject a plan that is proposed or has questions")
  .argument("<planId>")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(rejectPlanCommand);

// Hidden: the Architect process that `start-hub` runs in tmux (same binary in every layout).
program
  .command("architect", { hidden: true })
  .option("--hub <address>", "Hub address", "127.0.0.1")
  .option("--work-dir <path>", "read-only checkout for exploring the project")
  .action((opts: { hub: string; workDir?: string }) => {
    const architect = startArchitect({ hub: opts.hub, workDir: opts.workDir, token: resolveToken()?.token, version: layout.version() });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (architect.stop(), process.exit(0)));
  });

program
  .command("console-link")
  .description("Print a one-time link (and QR code) that signs a phone or another browser in to the console")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("--url <base>", "console address to put in the link (default: the Tailscale HTTPS address if served, else the LAN address)")
  .option("--dashboard-port <port>", "console port", parsePort, DEFAULT_DASHBOARD_PORT)
  .option("--no-qr", "print only the link")
  .action(consoleLinkCommand);

program
  .command("sync")
  .description("Show a project's push status to its remote, and retry a failed push")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("-P, --project <name>", "project (needed when the Hub has more than one)", process.env.ASO_PROJECT || undefined)
  .action(syncCommand);

program
  .command("status")
  .description("Show the Hub's version and update, its workers, and each project's work and last deploy")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(statusCommand);

program
  .command("deploy <project>")
  .description("Deploy a project's main now with its command from the Hub's deploy.json, and follow it to the end")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("--no-wait", "only start it")
  .action((project: string, opts: { hub: string; wait: boolean }) => deployCommand(project, opts));

const workerKeyCmd = program.command("worker-key").description("Let a worker machine join with its own key, or shut one out");
workerKeyCmd
  .command("new")
  .description("A one-time join code, and the commands to run with it on the new machine")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("--address <address>", "the Hub's address as the new machine reaches it (default: this machine's hostname)")
  .option("--name <name>", "a name for the machine's key (default: its hostname)")
  .option("--internet", "the machine joins from the internet, through the Hub's worker gateway (its --gateway-url)")
  .option("--projects <ids>", "comma-separated projects it may clone and work on (default: all)")
  .option("--untrusted", "someone else's machine: it only builds, and a trusted machine tests its work")
  .option("--budget <usd>", "USD of model calls its jobs may cause in total", parseUsd)
  .action(newWorkerKeyCommand);
workerKeyCmd
  .command("set <id>")
  .description("Change what a worker key may do: its projects, whether its machine is trusted, its model budget")
  .option("--projects <ids>", "comma-separated projects it may use")
  .option("--all-projects", "let it use every project")
  .option("--trusted", "its machine runs QA too")
  .option("--untrusted", "its machine only builds; a trusted machine tests its work")
  .option("--budget <usd>", "USD of model calls its jobs may cause in total", parseUsd)
  .option("--no-budget", "remove its budget")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action((id: string, opts) => setWorkerKeyCommand(id, opts));
workerKeyCmd
  .command("revoke <id>")
  .description("Revoke a worker key: its machine is disconnected and can't come back with it")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action((id: string, opts: { hub: string }) => revokeWorkerKeyCommand(id, opts));
program
  .command("worker-keys")
  .description("List the worker keys: which machine, whether connected, what it may do, revoked ones too")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(listWorkerKeysCommand);

program
  .command("providers")
  .description("The model providers the Hub can call (added ones and the .env's), with how many models each lists")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(providersCommand);
const providerCmd = program.command("provider").description("Add or remove a model provider: just its key, or a local server's address");
providerCmd
  .command("add <preset>")
  .description(`Add a provider: ${PROVIDER_PRESETS.join(", ")}. Asks for the key (hidden) unless --key; reads it from stdin when piped`)
  .option("--key <key>", "the API key (prefer the prompt: a key on the command line lands in your shell history)")
  .option("--url <url>", "the API's root, for ollama and custom (e.g. http://avalon:11434/v1)")
  .option("--name <id>", "its name on the Hub (default: the preset's), e.g. ollama-avalon for a second Ollama")
  .option("--vision", "its models accept images")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action((preset: string, opts) => {
    if (!isProviderPreset(preset)) throw new InvalidArgumentError(`expected one of: ${PROVIDER_PRESETS.join(", ")}`);
    return addProviderCommand(preset, opts);
  });
providerCmd
  .command("remove <id>")
  .description("Remove an added provider and forget its key")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(removeProviderCommand);

program
  .command("prices")
  .description("Model prices (USD per million tokens): the built-in ones and those set on the Hub")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(pricesCommand);
const priceCmd = program.command("price").description("Set a model's price so task budgets stop it too, or remove one");
priceCmd
  .command("set <model>")
  .description("Set a model's price (<provider>/<model> or its name); give the cache rates too, or cached tokens count at the input rate")
  .requiredOption("--input <usd>", "USD per million input tokens", parseUsd)
  .requiredOption("--output <usd>", "USD per million output tokens", parseUsd)
  .option("--cache-read <usd>", "USD per million cached input tokens read (agents read most input from the cache; default: --input)", parseUsd)
  .option("--cache-write <usd>", "USD per million input tokens written to the cache (default: --input)", parseUsd)
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(setPriceCommand);
priceCmd
  .command("remove <model>")
  .description("Remove a price set on the Hub")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(removePriceCommand);

program
  .command("models")
  .description("The models desks can use, by provider (see aso providers)")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(modelsCommand);
program
  .command("desks")
  .description("Which desks use a model of their own, and how busy each model is")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(desksCommand);
program
  .command("track-records")
  .description("How models, machines, desks, roles or projects have done: tasks finished, first tries, QA, acceptance, cost")
  .addOption(new Option("--by <key>", "group by").choices([...TRACK_RECORD_KEYS]).default("model"))
  .option("--project <name>", "only this project's tasks")
  .option("--role <role>", "only tasks of this role (frontend, backend, ...)")
  .option("--since <time>", "only jobs started at or after this time (ISO 8601, e.g. 2026-10-01)")
  .option("--json", "print the Hub's answer as JSON")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(trackRecordsCommand);
program
  .command("desk <target> <model>")
  .description("Put a desk (avalon#4), a whole machine (avalon), the Architect (architect) or the acceptance check (reviewer) on a model from `aso models`, or `default`")
  .option("--concurrency <n>", "that model's calls at once (default: 1 for local models, --llm-concurrency for Claude)", parsePositiveInt)
  .option("--base-url <url>", "call this model at another address than its provider's (better: add that server as a provider)")
  .option("--vision", "a local model that accepts images")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(deskCommand);
program
  .command("escalation [models]")
  .description("Show where failing tasks move, or change it while the Hub runs: stronger models from `aso models` (comma-separated, weakest first), or `default` for the Hub's --escalate-to")
  .option("--junior-tries <n>", "tries on a desk's model before a task escalates, counting the first attempt (0: straight to the ladder), or `default`", parseTriesOrDefault)
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(escalationCommand);

program
  .command("find-hub")
  .description(`Find the Hub on this LAN or over Tailscale (a UDP ${DEFAULT_DISCOVERY_PORT} query only that Hub can answer) and print its address`)
  .option("--join <code>", "find it with a one-time join code instead (before this machine has a key)")
  .action(findHubCommand);

program
  .command("token")
  .description("Print this Hub's ASO token (give it to workers as ASO_TOKEN or --token)")
  .action(() => {
    const auth = resolveToken();
    if (!auth) throw new Error(`no token yet: it is created on the first \`aso start-hub\` (${tokenFile()})`);
    console.log(auth.token);
  });

program
  .command("llm-check")
  .description("Send two tiny requests (a reply and a tool call) to check a model through its provider (costs a fraction of a cent)")
  .option("--model <spec>", "model to check: <provider>/<model> (see aso models); default: Claude Opus when Anthropic is a provider", process.env.ASO_MODEL || undefined)
  .option("-r, --root <dir>", "the Hub's projects folder, whose .aso/providers.json lists the added providers", DEFAULT_ROOT)
  .action(llmCheckCommand);

program
  .command("update")
  .description("Update this machine's aso to the version the Hub serves (or pull + rebuild a source checkout)")
  .option("--hub <address>", "Hub to update from", process.env.ASO_HUB || "127.0.0.1")
  .option("--spec <npm_spec>", "install from this npm spec instead (tarball path/URL, registry name)", process.env.ASO_UPDATE_SPEC)
  .action(updateCommand);

program.parseAsync().catch((err: unknown) => {
  console.error(`aso: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
