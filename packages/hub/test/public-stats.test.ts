import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publicModelName, publicStats, publicStatsFor, trackRecords, type ReportTask } from "@aso/hub";
import { createMessage, type JobRecord } from "@aso/shared";
import { postTask, pushTaskBranch, waitFor, withHub, worker } from "./helpers.ts";

const build = (model: string, extra: Partial<JobRecord> = {}): JobRecord => ({
  job: "implement", round: 0, host: "avalon", slot: 1, nodeId: "avalon-1", model, startedAt: "2026-10-27T12:00:00.000Z", endedAt: "2026-10-27T12:10:00.000Z", result: "built", calls: 3, costUsd: 0.2, ...extra,
});
const tasks: ReportTask[] = [
  { project: "aso-ui", state: "merged", spec: { role: "frontend" }, jobs: [build("gemini", { qa: "passed", acceptance: "met", acceptanceModel: "opus", acceptanceCostUsd: 0.05 })] },
  { project: "aso-ui", state: "merged", spec: { role: "frontend" }, jobs: [build("gemini", { result: "outOfTurns" }), build("opus", { round: 1, costUsd: 0.9 })] },
];
const plans = [{ project: "aso-ui", state: "approved" as const, model: "opus", dialogue: [{ kind: "proposal" }], llm: { costUsd: 0.4 }, createdAt: "2026-10-27T11:00:00.000Z" }];
const records = trackRecords(tasks, plans, { by: "model" });
const AT = "2026-11-03T05:00:00.000Z";

describe("public stats", () => {
  it("always shares the totals, and per model and costs only when chosen", () => {
    const totals = publicStats(records, [], AT);
    assert.deepEqual(totals, { since: "2026-10-27T12:00:00.000Z", at: AT, tasks: { finished: 2, firstTry: 1, tookOver: 1 }, plans: { proposed: 1, approved: 1 } });

    const all = publicStats(records, ["models", "costs"], AT);
    assert.deepEqual(all.costs, { totalUsd: 1.75, perTaskUsd: 0.88 }, "builds, plans and checks together");
    const opus = all.models!.find((m) => m.model === "opus")!;
    assert.deepEqual([opus.finished, opus.tookOver, opus.plansApproved, opus.checks, opus.checksMet, opus.costUsd, opus.costPerTaskUsd], [1, 1, 1, 1, 1, 1.35, 0.9]);
    const noCosts = publicStats(records, ["models"], AT);
    assert.ok(noCosts.costs === undefined && noCosts.models!.every((m) => m.costUsd === undefined && m.costPerTaskUsd === undefined));
  });

  it("publishes a model's name only in a safe form, and a machine's own model not at all", () => {
    assert.equal(publicModelName("machine/qwen3-coder:30b"), "a machine's own model");
    assert.equal(publicModelName("gemini/models/gemini-3.8-flash"), "gemini/models/gemini-3.8-flash");
    assert.equal(publicModelName("x`|<b>\n"), "xb");
    assert.equal(publicModelName("unknown model"), "unknown model");
    const local = trackRecords([{ project: "p", state: "merged", spec: { role: "r" }, jobs: [build("machine/llama-avalon-special")] }], [], { by: "model" });
    assert.equal(publicStats(local, ["models"], AT).models![0].model, "a machine's own model");
  });

  it("counts plans only from when jobs were first recorded, so costs per task cover one period", () => {
    const old = { ...plans[0], createdAt: "2026-10-16T09:00:00.000Z", llm: { costUsd: 30 } };
    const recent = { ...plans[0], createdAt: "2026-10-27T12:05:00.000Z" };
    const stats = publicStatsFor(tasks, [recent, old], { parts: ["costs"] }, AT);
    assert.deepEqual(stats.plans, { proposed: 1, approved: 1 }, "the plan from before job records isn't counted");
    assert.deepEqual(stats.costs, { totalUsd: 1.75, perTaskUsd: 0.88 });
    assert.deepEqual(publicStatsFor([], [old], { parts: [] }, AT).plans, { proposed: 0, approved: 0 }, "no jobs yet: no plans either");
  });

  it("counts only the projects it shares", () => {
    const other: ReportTask = { project: "blog", state: "merged", spec: { role: "r" }, jobs: [build("gemini")] };
    assert.equal(publicStatsFor([...tasks, other], plans, { parts: [], projects: ["blog"] }, AT).tasks.finished, 1);
    assert.equal(publicStatsFor([...tasks, other], plans, { parts: [] }, AT).tasks.finished, 3, "all, when none are named");
  });

  it("never names a machine, a desk, a project or a task", () => {
    const text = JSON.stringify(publicStats(records, ["models", "costs"], AT));
    for (const secret of ["avalon", "aso-ui", "frontend", "avalon-1"]) assert.ok(!text.includes(secret), secret);
  });
});

const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`).then(async (r) => ({ status: r.status, body: (await r.json()) as any, cache: r.headers.get("cache-control") }));

describe("public stats (Hub)", () => {
  it("is off unless the Hub is told to share", async () => {
    await withHub(
      async (ctx) => {
        assert.equal((await get(ctx.port, "/api/public-stats")).status, 404);
        assert.equal((await get(ctx.hub.gatewayPort!, "/api/public-stats")).status, 404);
      },
      { gateway: { port: 0 } },
    );
  });

  it("serves them to anyone, on the Hub's port and the worker gateway, from the chosen projects' work", async () => {
    await withHub(
      async (ctx) => {
        const w = await worker(ctx.port, "dev", { hostname: "avalon" });
        await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
        assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greet.txt": "hi" });
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged");

        const open = await get(ctx.port, "/api/public-stats");
        assert.equal(open.status, 200, "no token needed");
        assert.equal(open.body.tasks.finished, 1);
        assert.deepEqual(open.body.models.map((m: { model: string }) => m.model), ["unknown model"]);
        assert.equal(open.body.costs, undefined, "costs weren't chosen");
        assert.match(open.cache ?? "", /max-age=300/);
        assert.ok(!JSON.stringify(open.body).includes("avalon"));
        assert.deepEqual((await get(ctx.hub.gatewayPort!, "/api/public-stats")).body, open.body, "the same on the gateway");
        w.ws.close();
      },
      { gateway: { port: 0 }, qa: { enabled: false }, acceptanceCheck: false, publicStats: { parts: ["models"], projects: ["project"] } },
    );
  });

  it("leaves out projects it wasn't told to share", async () => {
    await withHub(
      async (ctx) => {
        const w = await worker(ctx.port, "dev");
        await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Greet", description: "d" });
        assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "in_progress", taskId: "greet", slot: 1 }));
        const commit = await pushTaskBranch(ctx.gitUrl, "greet", { "greet.txt": "hi" });
        w.send(createMessage("STATUS_UPDATE", "dev", { state: "completed", taskId: "greet", commit }));
        await waitFor(() => ctx.hub.tasks.get("greet")?.state === "merged");
        assert.equal((await get(ctx.port, "/api/public-stats")).body.tasks.finished, 0);
        w.ws.close();
      },
      { qa: { enabled: false }, acceptanceCheck: false, publicStats: { parts: [], projects: ["another-project"] } },
    );
  });
});
