import { randomUUID } from "node:crypto";
import path from "node:path";
import { AGENT_TOOLS, createLogger, hubGitUrl, orderPlan, type PayloadInput, type PlannedTask } from "@aso/shared";
import {
  AgentGitClient,
  AgentTools,
  ModelChannel,
  callModelWithRetry,
  describeToolCall,
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

  async plan(planId: string): Promise<PlanOutcome> {
    try {
      const repoDir = path.join(this.opts.workDir, "project");
      const git = await AgentGitClient.cloneOrOpen(repoDir, hubGitUrl(this.opts.hubUrl), { token: this.opts.token });
      await git.discardLocalChanges();
      const head = await git.checkoutMain();
      log.info(`${planId}: exploring main @ ${head.slice(0, 8)}`);

      const tools = new AgentTools({
        repoDir,
        role: "architect",
        requestDependency: async () => {
          throw new Error("the Architect cannot add dependencies");
        },
        setPackageScripts: async () => {
          throw new Error("the Architect cannot change package.json");
        },
        fileOperation: () => undefined,
      });

      const conversationId = randomUUID();
      let turn = 0;
      let results: ToolResult[] = [];
      for (;;) {
        const reply = await callModelWithRetry(
          (t) => this.opts.model.call({ planId }, t),
          { conversationId, turn, toolResults: results },
          (m) => log.warn(`${planId}: ${m}`),
          this.opts.retryDelaysMs,
        );
        turn = reply.turn + 1;
        log.info(`${planId} turn ${reply.turn}: ${reply.toolCalls.map(describeToolCall).join(", ") || reply.stopReason}`);

        const submit = reply.toolCalls.find((c) => c.name === "submit_plan");
        results = [];
        for (const call of reply.toolCalls) if (call !== submit) results.push(await tools.execute(call));

        if (submit) {
          const parsed = AGENT_TOOLS.submit_plan.input.safeParse(submit.input);
          const problem = parsed.success
            ? planProblem(parsed.data.tasks)
            : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
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

function planProblem(tasks: PlannedTask[]): string | undefined {
  const ordered = orderPlan(tasks);
  return typeof ordered === "string" ? ordered : undefined;
}
