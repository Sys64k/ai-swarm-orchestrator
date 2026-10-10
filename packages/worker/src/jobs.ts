import path from "node:path";
import {
  createLogger,
  type AgentMessageType,
  type MessageOf,
  type PayloadInput,
  type TaskId,
} from "@aso/shared";
import { AgentGitClient } from "./git/agent-git-client.js";
import { runCommand } from "./run-command.js";

const log = createLogger("jobs");

export type TaskAssignment = MessageOf<"TASK_ASSIGNMENT">["payload"];
export type TestExecution = MessageOf<"TEST_EXECUTION">["payload"];

export interface ExecutionContext {
  /** Checkout on `task/<id>`; the executor edits files here. */
  repoDir: string;
  /** Free-text progress, forwarded to the Hub as STATUS_UPDATE detail. */
  report(detail: string): void;
}

/** Does the actual work for a task. The LLM agent loop (Phase 5) implements this. */
export interface TaskExecutor {
  implement(task: TaskAssignment, ctx: ExecutionContext): Promise<{ commitMessage?: string } | void>;
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

  constructor(private readonly opts: JobRunnerOptions) {}

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
      });
      const done = await git.completeTask(result?.commitMessage ?? `${task.taskId}: ${task.title}`);
      send("STATUS_UPDATE", { state: "completed", taskId: task.taskId, commit: done.commit });
    } catch (err) {
      log.warn(`task ${task.taskId} failed: ${(err as Error).message}`);
      status("failed", (err as Error).message);
    }
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
    const env = { ...process.env, CI: "1" };
    const steps = [...job.setup.map((argv) => ({ argv, setup: true })), { argv: job.command, setup: false }];

    for (const { argv, setup } of steps) {
      const label = argv.join(" ");
      let result;
      try {
        result = await runCommand(argv, { cwd: this.repoDir, env, timeoutMs: Math.max(1000, deadline - Date.now()) });
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
