import path from "node:path";
import { createLogger, DeployNextSchema, ProjectIdSchema } from "@aso/shared";
import { deployWorkDir, runHere, type RunResult } from "@aso/hub";

const log = createLogger("deploy");

/** How often the host asks the Hub for a deploy job. */
export const DEPLOY_POLL_MS = 3_000;

export interface DeployRunner {
  stop(): void;
}

/**
 * The host side of deploys for a Hub in a container: take the Hub's deploy jobs and run them
 * here, where Docker and the operator's tools are. The export is already in the shared projects
 * folder, `<root>/.aso/deploy/<project>`.
 */
export function startDeployRunner(opts: { hubUrl: string; token: string; root: string; pollMs?: number; onDeployed?: () => void }): DeployRunner {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const headers = { authorization: `Bearer ${opts.token}`, "content-type": "application/json" };

  const once = async () => {
    const res = await fetch(`${opts.hubUrl}/api/deploys/next`, { headers });
    if (!res.ok) throw new Error(`the Hub answered ${res.status}`);
    const job = DeployNextSchema.parse(await res.json()).job;
    if (!job) return false;
    // The project id becomes a path: only a valid one.
    const project = ProjectIdSchema.safeParse(job.project);
    const result: RunResult = project.success
      ? await runHere(job, deployWorkDir(path.join(opts.root, ".aso"), project.data))
      : { ok: false, error: `invalid project id ${JSON.stringify(job.project)}`, output: "" };
    log.info(`${job.project} @ ${job.commit.slice(0, 7)}: deploy ${result.ok ? "succeeded" : `failed: ${result.error}`}`);
    if (result.ok) opts.onDeployed?.();
    const answer = await fetch(`${opts.hubUrl}/api/deploys/${encodeURIComponent(job.id)}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ok: result.ok,
        ...(result.error ? { error: result.error.slice(0, 2000) } : {}),
        exitCode: result.exitCode, // JSON leaves it out when undefined
        output: result.output.slice(-20_000),
      }),
    });
    if (!answer.ok) log.warn(`the Hub did not take the result of ${job.project}'s deploy (${answer.status}); it may have restarted`);
    return true;
  };

  const loop = async () => {
    if (stopped) return;
    let more = false;
    try {
      more = await once();
    } catch (err) {
      log.debug(`deploy runner: ${(err as Error).message}`);
    }
    if (!stopped) timer = setTimeout(() => void loop(), more ? 0 : (opts.pollMs ?? DEPLOY_POLL_MS));
  };
  void loop();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
