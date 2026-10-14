import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  PackageChangeSchema,
  createLogger,
  type AgentMessageType,
  type MessageOf,
  type PayloadInput,
  type TaskId,
} from "@aso/shared";
import { AgentGitClient } from "./git/agent-git-client.js";
import { ModelChannel, type ModelReply, type ModelTurn } from "./model-channel.js";
import { hostRunner, type CommandRunner } from "./sandbox.js";

const log = createLogger("jobs");

export type TaskAssignment = MessageOf<"TASK_ASSIGNMENT">["payload"];
export type TestExecution = MessageOf<"TEST_EXECUTION">["payload"];

export interface DependencyRequest {
  name: string;
  /** Semver range; omitted means latest. */
  version?: string;
  dev?: boolean;
}

export interface ExecutionContext {
  /** Checkout on `task/<id>`; the executor edits files here. */
  repoDir: string;
  /** Free-text progress, forwarded to the Hub as STATUS_UPDATE detail. */
  report(detail: string): void;
  /**
   * Ask the Hub to add npm packages. Resolves once the Hub committed them to main, this
   * branch was rebased onto that commit (uncommitted edits preserved) and `npm ci` ran.
   * Rejects with DependencyRejectedError if the Hub refused.
   */
  requestDependencies(packages: DependencyRequest[]): Promise<{ mainCommit: string }>;
  /**
   * Ask the Hub to add/update npm scripts (creating package.json if the project has none).
   * Resolves once the change is on main and this branch was rebased onto it.
   */
  setPackageScripts(scripts: Record<string, string>): Promise<{ mainCommit: string }>;
  /** One model turn via the Hub (which holds the conversation). */
  callModel(turn: ModelTurn): Promise<ModelReply>;
  /** Report an agent file edit to the Hub (audit trail / dashboard). */
  fileOperation(op: Omit<MessageOf<"FILE_OPERATION">["payload"], "taskId">): void;
  /** Where the agent's commands run (the job sandbox, or directly on this machine). */
  commands: CommandRunner;
}

export type { ModelReply, ModelTurn } from "./model-channel.js";

type PackageChangeInput = z.input<typeof PackageChangeSchema>;

export class DependencyRejectedError extends Error {
  override name = "DependencyRejectedError";
}

/** Does the actual work for a task. The LLM agent loop (Phase 5) implements this. */
export interface TaskExecutor {
  implement(task: TaskAssignment, ctx: ExecutionContext): Promise<{ commitMessage?: string; summary?: string } | void>;
}

export const unconfiguredExecutor: TaskExecutor = {
  async implement() {
    throw new Error("no agent executor configured on this worker (the LLM agent loop arrives in Phase 5)");
  },
};

export type Send = <T extends AgentMessageType>(type: T, payload: PayloadInput<T>) => void;

export interface JobRunnerOptions {
  workDir: string;
  gitUrl: string;
  nodeId: string;
  executor: TaskExecutor;
  send: Send;
  /** ASO token for the Hub's Git endpoint. */
  token?: string;
  /** How long to wait for the Hub to answer a dependency request. Default 15 min. */
  dependencyTimeoutMs?: number;
  /** How long to wait for one model turn. Default 20 min. */
  modelTimeoutMs?: number;
  /** Runs every command of a job (agent commands, npm ci, QA). Default: directly on this machine. */
  commands?: CommandRunner;
}

type DependencyResponse = MessageOf<"DEPENDENCY_RESPONSE">["payload"];

interface PendingDependency {
  message: PayloadInput<"DEPENDENCY_REQUEST">;
  resolve(response: DependencyResponse): void;
}

/** Feedback output budget (schema allows 100k; leave room for the envelope). */
const FEEDBACK_OUTPUT_CHARS = 50_000;

/**
 * Runs jobs one at a time, in arrival order. A job that outlives a disconnect keeps running;
 * the Hub decides whether it may resume (see `current`).
 */
export class JobRunner {
  private queue: Promise<void> = Promise.resolve();
  private active: { taskId: TaskId; job: "implement" | "test" } | undefined;
  private readonly pendingDependencies = new Map<string, PendingDependency>();
  private readonly model: ModelChannel;

  constructor(private readonly opts: JobRunnerOptions) {
    this.model = new ModelChannel(opts.send, opts.modelTimeoutMs);
  }

  private get commands(): CommandRunner {
    return this.opts.commands ?? hostRunner;
  }

  /** The job in progress, reported to the Hub on re-registration. */
  get current() {
    return this.active;
  }

  get repoDir(): string {
    return path.join(this.opts.workDir, "project");
  }

  enqueueTask(task: TaskAssignment): void {
    this.enqueue({ taskId: task.taskId, job: "implement" }, () => this.implement(task));
  }

  enqueueTest(job: TestExecution): void {
    this.enqueue({ taskId: job.taskId, job: "test" }, () => this.test(job));
  }

  handleDependencyResponse(response: DependencyResponse): void {
    const pending = this.pendingDependencies.get(response.requestId);
    if (!pending) return log.debug(`ignoring response for unknown dependency request ${response.requestId}`);
    this.pendingDependencies.delete(response.requestId);
    pending.resolve(response);
  }

  handlePromptResult(reply: ModelReply): void {
    this.model.handleResult(reply);
  }

  /** After a reconnect: ask again for answers that may have been lost (the Hub de-duplicates). */
  resendPending(): void {
    for (const pending of this.pendingDependencies.values()) this.opts.send("DEPENDENCY_REQUEST", pending.message);
    this.model.resendPending();
  }

  /** Resolves when all queued jobs are done (used by tests and shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(job: NonNullable<JobRunner["active"]>, fn: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      this.active = job;
      try {
        await fn();
      } catch (err) {
        log.error(`job ${job.job} ${job.taskId} crashed`, err);
      } finally {
        this.active = undefined;
      }
    });
  }

  private async openRepo(role: string): Promise<AgentGitClient> {
    const git = await AgentGitClient.cloneOrOpen(this.repoDir, this.opts.gitUrl, {
      author: { name: `ASO ${role} agent (${this.opts.nodeId})`, email: `${this.opts.nodeId}@aso.local` },
      token: this.opts.token,
    });
    await git.discardLocalChanges();
    return git;
  }

  private async implement(task: TaskAssignment): Promise<void> {
    const { send } = this.opts;
    const status = (state: "in_progress" | "failed", detail?: string) =>
      send("STATUS_UPDATE", { state, taskId: task.taskId, detail: detail?.slice(0, 2000) });
    try {
      const git = await this.openRepo(task.role);
      const { resumed } = await git.startTask(task.taskId);
      if (resumed) await git.syncWithMain();
      status("in_progress", task.rework ? `rework round ${task.rework.round}` : undefined);

      const result = await this.opts.executor.implement(task, {
        repoDir: this.repoDir,
        report: (detail) => status("in_progress", detail),
        requestDependencies: (packages) => this.requestPackageChange(task, git, { type: "add_dependencies", packages }),
        setPackageScripts: (scripts) => this.requestPackageChange(task, git, { type: "set_scripts", scripts }),
        callModel: (turn) => this.model.call({ taskId: task.taskId }, turn),
        fileOperation: (op) => send("FILE_OPERATION", { ...op, taskId: task.taskId } as PayloadInput<"FILE_OPERATION">),
        commands: this.commands,
      });
      const done = await git.completeTask(result?.commitMessage ?? `${task.taskId}: ${task.title}`);
      send("STATUS_UPDATE", {
        state: "completed",
        taskId: task.taskId,
        commit: done.commit,
        detail: result?.summary?.slice(0, 2000),
      });
    } catch (err) {
      log.warn(`task ${task.taskId} failed: ${(err as Error).message}`);
      status("failed", (err as Error).message);
    }
  }

  private async requestPackageChange(
    task: TaskAssignment,
    git: AgentGitClient,
    input: PackageChangeInput,
  ): Promise<{ mainCommit: string }> {
    const change = PackageChangeSchema.parse(input);
    const label =
      change.type === "add_dependencies"
        ? change.packages.map((p) => `${p.name}${p.version ? `@${p.version}` : ""}`).join(", ")
        : `scripts ${Object.keys(change.scripts).join(", ")}`;
    const { send } = this.opts;
    const message: PayloadInput<"DEPENDENCY_REQUEST"> = { requestId: randomUUID(), taskId: task.taskId, change };

    send("STATUS_UPDATE", { state: "waiting_dependency", taskId: task.taskId, detail: `waiting for ${label}` });
    const response = await new Promise<DependencyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDependencies.delete(message.requestId);
        reject(new Error(`no answer from the Hub for ${label}`));
      }, this.opts.dependencyTimeoutMs ?? 15 * 60_000);
      this.pendingDependencies.set(message.requestId, {
        message,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      send("DEPENDENCY_REQUEST", message);
    });

    if (response.outcome === "rejected") {
      send("STATUS_UPDATE", { state: "in_progress", taskId: task.taskId, detail: `${label} rejected` });
      throw new DependencyRejectedError(response.reason);
    }

    await git.syncWithMain();
    // Only a new dependency needs installing; script changes don't touch node_modules.
    if (change.type === "add_dependencies" && existsSync(path.join(this.repoDir, "package-lock.json"))) {
      // Install scripts are code from the registry: they run where agent commands run.
      const result = await this.commands.run(["npm", "ci", "--no-audit", "--no-fund"], {
        cwd: this.repoDir,
        timeoutMs: 10 * 60_000,
      });
      if (result.exitCode !== 0) {
        throw new Error(`npm ci failed after adding ${label}: ${result.output.slice(-2000)}`);
      }
    }
    send("STATUS_UPDATE", { state: "in_progress", taskId: task.taskId, detail: `${label} applied` });
    log.info(`${label} applied (main @ ${response.mainCommit.slice(0, 8)})`);
    return { mainCommit: response.mainCommit };
  }


  private async test(job: TestExecution): Promise<void> {
    const { send } = this.opts;
    try {
      const git = await this.openRepo("qa");
      await git.checkoutCommit(job.taskId, job.commit);
    } catch (err) {
      return send("STATUS_UPDATE", { state: "failed", taskId: job.taskId, detail: (err as Error).message.slice(0, 2000) });
    }
    send("STATUS_UPDATE", { state: "in_progress", taskId: job.taskId });

    const deadline = Date.now() + job.timeoutSec * 1000;
    // CI=1 keeps runners like Vitest and Jest out of watch/interactive mode.
    const env = { CI: "1" };
    const steps = [...job.setup.map((argv) => ({ argv, setup: true })), { argv: job.command, setup: false }];

    for (const { argv, setup } of steps) {
      const label = argv.join(" ");
      let result;
      try {
        result = await this.commands.run(argv, { cwd: this.repoDir, env, timeoutMs: Math.max(1000, deadline - Date.now()) });
      } catch (err) {
        // The program could not start at all: a problem with this node, not with the code.
        return send("STATUS_UPDATE", { state: "failed", taskId: job.taskId, detail: `cannot run ${label}: ${(err as Error).message}` });
      }
      if (result.exitCode === 0) {
        log.info(`${label} ok (${(result.durationMs / 1000).toFixed(1)}s)`);
        continue;
      }
      const why = result.timedOut
        ? `timed out after ${job.timeoutSec}s`
        : `exited with ${result.exitCode ?? result.signal}`;
      return send("FEEDBACK_LOOP", {
        taskId: job.taskId,
        commit: job.commit,
        outcome: "fail",
        summary: `${setup ? "setup step" : "tests"} \`${label}\` ${why}`,
        failures: [{ message: `\`${label}\` ${why}` }],
        output: result.output.slice(-FEEDBACK_OUTPUT_CHARS) || undefined,
      });
    }
    send("FEEDBACK_LOOP", {
      taskId: job.taskId,
      commit: job.commit,
      outcome: "pass",
      summary: `\`${job.command.join(" ")}\` passed`,
    });
  }
}
