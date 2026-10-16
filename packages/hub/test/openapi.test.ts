import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { z } from "zod";
import { readFileSync } from "node:fs";
import { API_DOC_VERSION, API_OPERATIONS, openApiDocument, operationId } from "@aso/hub";
import {
  HealthSchema,
  LlmStatusSchema,
  NodeSchema,
  PlanSchema,
  ProjectSchema,
  PushCheckSchema,
  PushRemovedSchema,
  PushStatusSchema,
  SignedInSchema,
  SignInCodeSchema,
  SyncStatusSchema,
  TaskSchema,
  TranscriptSchema,
  VersionSchema,
} from "@aso/shared";
import { TOKEN, withHub, worker } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

const call = async (port: number, route: string, init: { method?: string; body?: unknown; auth?: boolean } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json()) as unknown };
};

/** `value` fits `schema`, and (for objects) has no field the schema doesn't name: the description is complete. */
function conforms(schema: z.ZodType, value: unknown, what: string): void {
  const result = schema.safeParse(value);
  assert.ok(result.success, `${what}: ${result.success ? "" : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (shape && value && typeof value === "object" && !Array.isArray(value)) {
    const undocumented = Object.keys(value).filter((k) => !(k in shape));
    assert.deepEqual(undocumented, [], `${what} has fields the API description does not list`);
  }
}

describe("API description", () => {
  it("describes exactly the routes the Hub answers", () =>
    withHub(async (ctx) => {
      const served = ctx.hub
        .routes()
        .filter((r) => r.path.startsWith("/api/") || r.path.startsWith("/dist/"))
        .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`);
      const described = API_OPERATIONS.map((op) => `${op.method.toUpperCase()} ${op.path}`);
      assert.deepEqual([...new Set(served)].sort(), [...described].sort());
    }));

  it("is served without the token as OpenAPI 3.1, with every reference resolving", () =>
    withHub(async (ctx) => {
      const { status, body } = await call(ctx.port, "/api/openapi.json", { auth: false });
      assert.equal(status, 200);
      const doc = body as { openapi: string; info: { version: string }; components: { schemas: Record<string, unknown> }; paths: Record<string, Record<string, Record<string, unknown>>> };
      assert.equal(doc.openapi, "3.1.0");
      assert.equal(doc.info.version, "unknown", "no package served in tests");
      const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
      assert.ok(refs.length > 30);
      for (const name of refs) assert.ok(doc.components.schemas[name], `${name} is defined`);
      assert.deepEqual(doc.paths["/api/version"].get.security, [], "public");
      assert.ok((doc.paths["/api/tasks"].post.responses as Record<string, unknown>)["401"], "needs the token");
      const task = doc.components.schemas.Task as { properties: Record<string, unknown>; required: string[] };
      assert.ok(task.properties.review && task.required.includes("state"));
      const createTask = doc.components.schemas.CreateTask as { required: string[] };
      assert.ok(!createTask.required.includes("taskId") && !createTask.required.includes("kind"), "request bodies list what a client must send");
    }));

  it("names every operation uniquely, for generated clients", () => {
    const ids = API_OPERATIONS.map((op) => operationId(op));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(operationId({ method: "get", path: "/api/tasks/{id}/transcript" }), "getTaskTranscript");
    assert.equal(operationId({ method: "post", path: "/api/push/subscriptions/check" }), "postPushSubscriptionsCheck");
    assert.equal(operationId({ method: "get", path: "/api/plans" }), "getPlans");
    assert.equal(operationId({ method: "get", path: "/dist/aso.tgz", id: "getPackage" }), "getPackage");
  });

  it("is the same as docs/openapi.json (run npm run openapi after changing the API)", () => {
    const committed = JSON.parse(readFileSync(new URL("../../../docs/openapi.json", import.meta.url), "utf8")) as unknown;
    assert.deepEqual(committed, openApiDocument(API_DOC_VERSION));
  });

  it("matches what the Hub answers", () =>
    withHub(async (ctx) => {
      const w = await worker(ctx.port, "dev", { supervisor: "systemd" });
      const get = async (route: string) => {
        const r = await call(ctx.port, route);
        assert.equal(r.status, 200, route);
        return r.body;
      };

      conforms(VersionSchema, (await call(ctx.port, "/api/version", { auth: false })).body, "version");
      conforms(HealthSchema, (await call(ctx.port, "/api/health", { auth: false })).body, "health without the token");
      conforms(HealthSchema, await get("/api/health"), "health");
      conforms(LlmStatusSchema, await get("/api/llm"), "llm");
      conforms(PushStatusSchema, await get("/api/push"), "push");
      conforms(SyncStatusSchema, await get("/api/sync"), "sync");

      const created = await call(ctx.port, "/api/tasks", { method: "POST", body: { taskId: "greet", role: "backend", title: "Greet", description: "Say hello" } });
      assert.equal(created.status, 201);
      conforms(TaskSchema, created.body, "created task");
      await w.next(); // the assignment
      for (const t of (await get("/api/tasks")) as unknown[]) conforms(TaskSchema, t, "task");
      conforms(TaskSchema, await get("/api/tasks/greet"), "task");
      conforms(TranscriptSchema, await get("/api/tasks/greet/transcript"), "task transcript");
      conforms(TaskSchema, (await call(ctx.port, "/api/tasks/greet/cancel", { method: "POST" })).body, "cancelled task");

      const plan = await call(ctx.port, "/api/plans", { method: "POST", body: { requirement: "A greeting page" } });
      assert.equal(plan.status, 201);
      conforms(PlanSchema, plan.body, "created plan");
      const planId = (plan.body as { planId: string }).planId;
      for (const p of (await get("/api/plans")) as unknown[]) conforms(PlanSchema, p, "plan");
      conforms(TranscriptSchema, await get(`/api/plans/${planId}/transcript`), "plan transcript");
      conforms(PlanSchema, (await call(ctx.port, `/api/plans/${planId}/reject`, { method: "POST" })).body, "rejected plan");

      for (const p of (await get("/api/projects")) as unknown[]) conforms(ProjectSchema, p, "project");
      conforms(ProjectSchema, await get("/api/projects/project"), "project");
      for (const n of (await get("/api/nodes")) as unknown[]) conforms(NodeSchema, n, "node");
      conforms(NodeSchema, (await call(ctx.port, "/api/nodes/dev/drain", { method: "POST" })).body, "drained node");

      const code = await call(ctx.port, "/api/sign-in-codes", { method: "POST" });
      assert.equal(code.status, 201);
      conforms(SignInCodeSchema, code.body, "sign-in code");
      const redeemed = await call(ctx.port, "/api/sign-in-codes/redeem", { method: "POST", body: { code: (code.body as { code: string }).code } });
      conforms(SignedInSchema, redeemed.body, "redeemed code");
      const endpoint = { endpoint: "https://push.example/device" };
      conforms(PushCheckSchema, (await call(ctx.port, "/api/push/subscriptions/check", { method: "POST", body: endpoint })).body, "push check");
      conforms(PushRemovedSchema, (await call(ctx.port, "/api/push/subscriptions/delete", { method: "POST", body: endpoint })).body, "push removal");
      w.ws.close();
    }));

  it("refuses bodies that don't fit, saying which field", () =>
    withHub(async (ctx) => {
      const post = (route: string, body: unknown) => call(ctx.port, route, { method: "POST", body });
      const bad = async (route: string, body: unknown, message: RegExp) => {
        const r = await post(route, body);
        assert.equal(r.status, 400, route);
        assert.match((r.body as { error: string }).error, message);
      };
      await bad("/api/tasks", { role: "backend", title: "t" }, /description/);
      await bad("/api/tasks", [1], /body/);
      await bad("/api/plans", { requirement: "" }, /requirement/);
      await bad("/api/projects", { name: "Not OK" }, /name: project name must be lowercase/);
      await bad("/api/sync", { project: 5 }, /project/);
      assert.equal((await call(ctx.port, "/api/sync", { method: "POST" })).status, 200, "the sync body may be left out");
      assert.equal((await post("/api/sign-in-codes/redeem", { code: 42 })).status, 410, "a wrong code is just a used-up code");
    }));
});
