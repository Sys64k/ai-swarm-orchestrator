import { execFile } from "node:child_process";
import {
  createLogger,
  type MessageOf,
  type PayloadInput,
} from "@aso/shared";
import type { DependencyInstaller, DependencySpec, HubRepository } from "./git/hub-repo.js";
import type { NodeRegistry } from "./registry.js";
import type { TaskManager } from "./tasks.js";

const log = createLogger("deps");

type Request = MessageOf<"DEPENDENCY_REQUEST">["payload"];
type Response = PayloadInput<"DEPENDENCY_RESPONSE">;

const NPM_TIMEOUT_MS = 5 * 60_000;

/**
 * Updates package.json + package-lock.json only. `--package-lock-only` resolves from the
 * registry without creating node_modules and `--ignore-scripts` means no package code ever
 * runs on the Hub; workers install for real with `npm ci`.
 */
export const npmInstaller: DependencyInstaller = {
  async install(dir, packages) {
    // --save and --save-dev are per command, so runtime and dev packages are installed separately.
    for (const dev of [false, true]) {
      const specs = packages.filter((p) => p.dev === dev).map(packageSpec);
      if (specs.length) await npmInstall(dir, specs, dev);
    }
  },
};

function packageSpec(p: DependencySpec): string {
  return p.version ? `${p.name}@${p.version}` : p.name;
}

function npmInstall(dir: string, specs: string[], dev: boolean): Promise<void> {
  const args = [
    "install",
    ...specs,
    dev ? "--save-dev" : "--save",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ];
  return new Promise((resolve, reject) => {
    execFile("npm", args, { cwd: dir, timeout: NPM_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const detail = stderr.trim().split("\n").slice(-15).join("\n") || err.message;
      reject(new Error(`npm install ${specs.join(" ")} failed: ${detail}`));
    });
  });
}

export interface DependencyManagerOptions {
  installer?: DependencyInstaller;
  /** Allowed package names; `@scope/*` allows a whole scope. Undefined allows everything. */
  allow?: readonly string[];
  maxPerTask?: number;
}

interface Entry {
  nodeId: string;
  taskId: string;
  response?: Response;
}

/**
 * DEPENDENCY_REQUEST handling: workers may not touch package.json, so the Hub adds packages on
 * main (under the main lock) and tells the worker to rebase.
 */
export class DependencyManager {
  private readonly installer: DependencyInstaller;
  private readonly allow?: readonly string[];
  private readonly maxPerTask: number;
  /** By requestId: makes retries after a reconnect idempotent. */
  private readonly requests = new Map<string, Entry>();
  private readonly perTask = new Map<string, number>();

  constructor(
    private readonly repo: HubRepository,
    private readonly tasks: TaskManager,
    private readonly registry: NodeRegistry,
    opts: DependencyManagerOptions = {},
  ) {
    this.installer = opts.installer ?? npmInstaller;
    this.allow = opts.allow?.length ? opts.allow : undefined;
    this.maxPerTask = opts.maxPerTask ?? 10;
  }

  /** Returns a protocol error string, or undefined if the request was accepted for handling. */
  handle(nodeId: string, req: Request): string | undefined {
    const existing = this.requests.get(req.requestId);
    if (existing) {
      if (existing.nodeId !== nodeId) return `request ${req.requestId} belongs to another node`;
      // Retry after a reconnect: answer again if done; otherwise the pending answer will come.
      if (existing.response) this.respond(nodeId, existing.response);
      return undefined;
    }

    const entry: Entry = { nodeId, taskId: req.taskId };
    this.requests.set(req.requestId, entry);
    const reject = (reason: string) => this.finish(entry, { requestId: req.requestId, outcome: "rejected", reason });

    if (!this.tasks.isImplementing(nodeId, req.taskId)) {
      reject(`task ${req.taskId} is not being implemented by ${nodeId}`);
      return undefined;
    }
    const { change } = req;
    const denied = change.type === "add_dependencies" && this.allow ? change.packages.filter((p) => !this.allowed(p.name)) : [];
    if (denied.length) {
      reject(`${denied.map((p) => p.name).join(", ")} ${denied.length === 1 ? "is" : "are"} not on the Hub's dependency allowlist`);
      return undefined;
    }
    const count = (this.perTask.get(req.taskId) ?? 0) + 1;
    if (count > this.maxPerTask) {
      reject(`task ${req.taskId} reached the limit of ${this.maxPerTask} package change requests`);
      return undefined;
    }
    this.perTask.set(req.taskId, count);

    const added = change.type === "add_dependencies" ? change.packages.map((p) => `${packageSpec(p)}${p.dev ? " (dev)" : ""}`) : [];
    const label =
      change.type === "add_dependencies"
        ? added.join(", ")
        : `scripts ${Object.entries(change.scripts).map(([k, v]) => `${k}="${v}"`).join(", ")}`;
    // A long list goes in the commit body so the subject stays readable.
    const many = added.length > 3;
    const subject =
      change.type === "add_dependencies"
        ? `chore(deps): add ${many ? `${added.length} packages` : label}`
        : `chore: set npm ${label}`;
    const body = many ? `${added.join("\n")}\n\n` : "";
    log.info(`${nodeId} requests ${label} for task ${req.taskId}`);
    this.tasks.recordEvent(req.taskId, `package change requested: ${label}`);

    void this.repo
      .changePackage(change, this.installer, `${subject}\n\n${body}Requested by task ${req.taskId}.`)
      .then(
        (result) => {
          if (!result.ok) return reject(result.reason);
          this.tasks.recordEvent(
            req.taskId,
            result.changed
              ? `package change ${label} committed on main @ ${result.mainCommit.slice(0, 8)}`
              : `package change ${label} already in place on main`,
          );
          this.finish(entry, { requestId: req.requestId, outcome: "installed", mainCommit: result.mainCommit });
        },
        (err: Error) => reject(`dependency install error: ${err.message}`),
      );
    return undefined;
  }

  private finish(entry: Entry, response: Response): void {
    entry.response = response;
    if (response.outcome === "rejected") {
      log.warn(`dependency request ${response.requestId} rejected: ${response.reason}`);
      this.tasks.recordEvent(entry.taskId, `package change rejected: ${response.reason}`);
    }
    this.respond(entry.nodeId, response);
  }

  /** If the node is offline, it re-sends the request after reconnecting and gets the cached answer. */
  private respond(nodeId: string, response: Response): void {
    if (this.registry.has(nodeId)) this.registry.send(nodeId, "DEPENDENCY_RESPONSE", response);
  }

  private allowed(name: string): boolean {
    return this.allow!.some((rule) => (rule.endsWith("/*") ? name.startsWith(rule.slice(0, -1)) : rule === name));
  }
}
