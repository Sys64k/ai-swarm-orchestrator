import { randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_TOOLS, createLogger, hubGitUrl, orderPlan, type PayloadInput, type PlannedTask } from "@aso/shared";
import {
  AgentGitClient,
  AgentTools,
  ModelChannel,
  callModelWithRetry,
  describeToolCall,
  fitTurnResults,
  type ToolResult,
} from "@aso/worker";

const log = createLogger("architect");

export type PlanOutcome = PayloadInput<"PLAN_RESULT">;

/**
 * One planning run: explore a read-only checkout of main, talk to the model through the Hub,
 * and return the tasks the model submits (validated, so the model can fix a broken plan).
 */
export class Planner {
  constructor(
    private readonly opts: {
      hubUrl: URL;
      workDir: string;
      model: ModelChannel;
      retryDelaysMs?: number[];
      token?: string;
    },
  ) {}

  async plan(planId: string, project: string): Promise<PlanOutcome> {
    try {
      // One read-only checkout per project, reused across that project's plans.
      const repoDir = path.join(this.opts.workDir, project);
      const git = await AgentGitClient.cloneOrOpen(repoDir, hubGitUrl(this.opts.hubUrl, project), { token: this.opts.token });
      await git.discardLocalChanges();
      const head = await git.checkoutMain();
      log.info(`${planId}: exploring main @ ${head.slice(0, 8)}`);

      const tools = new AgentTools({
        repoDir,
        role: "architect",
        requestDependencies: async () => {
          throw new Error("the Architect cannot add dependencies");
        },
        setPackageScripts: async () => {
          throw new Error("the Architect cannot change package.json");
        },
        fileOperation: () => undefined,
        // The Architect's role has no run_command; this only backs that up.
        commands: {
          kind: "host",
          run: async () => {
            throw new Error("the Architect cannot run commands");
          },
        },
      });

      const conversationId = randomUUID();
      let turn = 0;
      let results: ToolResult[] = [];
      for (;;) {
        const reply = await callModelWithRetry(
          (t) => this.opts.model.call({ planId }, t),
          { conversationId, turn, toolResults: fitTurnResults(results) },
          (m) => log.warn(`${planId}: ${m}`),
          this.opts.retryDelaysMs,
        );
        turn = reply.turn + 1;
        log.info(`${planId} turn ${reply.turn}: ${reply.toolCalls.map(describeToolCall).join(", ") || reply.stopReason}`);

        const ask = reply.toolCalls.find((c) => c.name === "ask_questions");
        const submit = reply.toolCalls.find((c) => c.name === "submit_plan");
        results = [];
        for (const call of reply.toolCalls) if (call !== submit && call !== ask) results.push(await tools.execute(call));

        if (ask && !submit) {
          const parsed = AGENT_TOOLS.ask_questions.input.safeParse(ask.input);
          if (parsed.success) {
            log.info(`${planId}: asking ${parsed.data.questions.length} question(s)`);
            return { planId, outcome: "questions", questions: parsed.data.questions, context: parsed.data.context };
          }
          results.push({ toolUseId: ask.id, content: `invalid questions, fix and ask again: ${issues(parsed.error)}`, isError: true });
        } else if (ask) {
          results.push({ toolUseId: ask.id, content: "ignored: you also submitted a plan in this turn", isError: true });
        }

        if (submit) {
          const parsed = AGENT_TOOLS.submit_plan.input.safeParse(submit.input);
          const problem = parsed.success
            ? planProblem(parsed.data.tasks)
            : issues(parsed.error);
          if (parsed.success && !problem) {
            log.info(`${planId}: proposing ${parsed.data.tasks.length} task(s)`);
            return { planId, outcome: "proposed", summary: parsed.data.summary, tasks: parsed.data.tasks };
          }
          results.push({ toolUseId: submit.id, content: `plan rejected, fix it and submit again: ${problem}`, isError: true });
        } else if (reply.toolCalls.length === 0) {
          results = [];
          return { planId, outcome: "failed", error: `the model stopped without submitting a plan: ${reply.text.slice(0, 1000) || "(no text)"}` };
        }
      }
    } catch (err) {
      log.error(`${planId} failed: ${(err as Error).message}`);
      return { planId, outcome: "failed", error: (err as Error).message.slice(0, 5000) };
    }
  }
}

function issues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

function planProblem(tasks: PlannedTask[]): string | undefined {
  const ordered = orderPlan(tasks);
  return typeof ordered === "string" ? ordered : undefined;
}
