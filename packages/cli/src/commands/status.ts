import { formatDuration, hubHttpBase, shortCommit, type ApiDeployStatus, type ApiNode, type ApiProject, type HubUpdate } from "@aso/shared";
import { api, HubApiError } from "../hub-api.js";

/** How often `aso deploy` asks how the deploy is going. */
const DEPLOY_POLL_MS = 2_000;
/** Lines of a failed deploy's output `aso deploy` shows. */
const OUTPUT_LINES = 30;
/** How long `aso deploy` follows a deploy: longer than the Hub's own limit for one (15 min) plus a queued one. */
export const DEPLOY_WAIT_MS = 35 * 60_000;

/** One line on the Hub: what it runs and where its own update stands. */
export function hubLine(update: HubUpdate): string {
  const runs = `Hub ${update.current}`;
  const target = update.target ? shortCommit(update.target) : "a new version";
  switch (update.state) {
    case "off":
      return `${runs} (doesn't update itself)`;
    case "current":
      return `${runs}, up to date with its repository`;
    case "building":
      return `${runs}, building and testing ${target}`;
    case "waiting":
      return `${runs}, ${target} is ready: waiting until no task, deploy or planning would be interrupted`;
    case "restarting":
      return `${runs}, restarting onto ${target}`;
    case "updated":
      return `${runs}, just updated`;
    case "failed":
      return `${runs}, update ${update.target ? `to ${target} ` : ""}failed: ${update.error ?? "no reason given"}`;
  }
}

/** One line per worker: name, what it does, and whether it runs another build. */
export function workerLine(node: ApiNode): string {
  const name = node.hardware?.hostname ?? node.nodeId;
  const jobs = node.currentTaskIds.length;
  const doing = node.draining ? "draining" : jobs ? `working (${jobs} of ${node.slots} jobs)` : "idle";
  return `${name}: ${doing}${node.outdated ? `, runs ${node.version} (updates when idle)` : ""}`;
}

/** What a project's last deploy did, or undefined when it has no deploy command. */
export function deployLine(deploy: ApiProject["deploy"]): string | undefined {
  if (!deploy.configured) return undefined;
  return deploy.last ? deployStatusLine(deploy.last) : "no deploy since the Hub started";
}

/** What one deploy did, or is doing. */
export function deployStatusLine(last: ApiDeployStatus): string {
  const commit = shortCommit(last.commit);
  if (last.state === "running") return `deploying ${commit}`;
  const how = last.finishedAt ? ` in ${formatDuration(Date.parse(last.finishedAt) - Date.parse(last.startedAt))}` : "";
  return last.state === "succeeded" ? `deployed ${commit}${how}` : `deploy of ${commit} failed${how}: ${last.error ?? "no reason given"}`;
}

/** A project's line: its work, and its deploy if it has a command. */
export function projectLine(project: ApiProject): string {
  const t = project.tasks;
  const work = [t.running && `${t.running} running`, t.queued && `${t.queued} queued`, t.reviewing && `${t.reviewing} to review`, t.failed && `${t.failed} failed`]
    .filter(Boolean)
    .join(", ");
  const plans = project.plansAwaitingApproval ? `${project.plansAwaitingApproval} plan(s) to approve` : "";
  return [`${project.id}:`, [work || "no work in progress", plans, deployLine(project.deploy)].filter(Boolean).join("; ")].join(" ");
}

/** `aso status`: the Hub, its workers and projects, in a few lines. Exits 1 when something failed. */
export async function statusCommand(opts: { hub: string }): Promise<void> {
  const base = hubHttpBase(opts.hub);
  const [update, nodes, projects] = await Promise.all([
    api<HubUpdate>(base, "/api/hub/update").catch((err: unknown) => {
      if (err instanceof HubApiError && err.status === 404) return undefined; // an older Hub has none
      throw err;
    }),
    api<ApiNode[]>(base, "/api/nodes"),
    api<ApiProject[]>(base, "/api/projects"),
  ]);
  if (update) console.log(hubLine(update));
  const workers = nodes.filter((n) => n.nodeKind === "worker");
  console.log(`\nWorkers (${workers.length}):${workers.length ? "" : " none connected"}`);
  for (const n of workers) console.log(`  ${workerLine(n)}`);
  if (!nodes.some((n) => n.nodeKind === "architect")) console.log("  The Architect is not connected: new plans wait.");
  console.log(`\nProjects (${projects.length}):`);
  for (const p of projects) console.log(`  ${projectLine(p)}`);
  if (update?.state === "failed" || projects.some((p) => p.deploy.last?.state === "failed")) process.exitCode = 1;
}

/** Whether `now` is the deploy started after `before` and it has ended. */
export function deployEnded(before: ApiDeployStatus | undefined, now: ApiDeployStatus | undefined): now is ApiDeployStatus {
  return !!now && now.state !== "running" && (!before || Date.parse(now.startedAt) > Date.parse(before.startedAt));
}

/** `aso deploy <project>`: deploy its main now and, unless `--no-wait`, follow it to the end. Exits 1 when it fails. */
export async function deployCommand(project: string, opts: { hub: string; wait: boolean }): Promise<void> {
  const base = hubHttpBase(opts.hub);
  const path = `/api/projects/${encodeURIComponent(project)}`;
  const before = (await api<ApiProject>(base, path)).deploy.last;
  await api(base, `${path}/deploy`, { method: "POST" });
  if (!opts.wait) return void console.log(`${project}: deploying (aso status shows how it went)`);
  console.log(`${project}: deploying…`);
  const until = Date.now() + DEPLOY_WAIT_MS;
  let last: ApiDeployStatus | undefined;
  for (;;) {
    last = (await api<ApiProject>(base, path)).deploy.last;
    if (deployEnded(before, last)) break;
    if (Date.now() > until) throw new Error(`${project}'s deploy hasn't ended after ${DEPLOY_WAIT_MS / 60_000} min; aso status shows how it goes`);
    await new Promise((r) => setTimeout(r, DEPLOY_POLL_MS));
  }
  const line = deployStatusLine(last);
  if (last.state === "succeeded") return void console.log(`${project}: ${line}`);
  console.error(`${project}: ${line}`);
  const output = last.output?.trimEnd().split("\n").slice(-OUTPUT_LINES).join("\n");
  if (output) console.error(`\nLast lines of its output:\n${output}`);
  process.exitCode = 1;
}
