import { z } from "zod";
import { ANSWER_SCHEMAS, API_OPERATIONS, API_TAGS, REQUEST_SCHEMAS, type Answer, type AnswerName, type ApiOperation, type RequestName } from "./operations.js";

export { API_OPERATIONS, type ApiOperation } from "./operations.js";

/** The version docs/openapi.json is written with: the API's, not a build's, so the file only changes with the API. */
export const API_DOC_VERSION = "0.1.0";

const DESCRIPTION =
  "The Hub's HTTP API, as the console and the aso CLI use it. Send the ASO token as `Authorization: Bearer <token>` (run `aso token` on the Hub). " +
  "Answers may carry fields not listed here; ignore what you don't know. " +
  "Workers and the Architect talk to the Hub over the WebSocket at /ws and Git at /git/<project>.git instead.";

/**
 * `GET /api/tasks/{id}/transcript` → `getTaskTranscript`: stable names for generated clients.
 * A collection followed by `{id}` names one of them (tasks/{id} → Task); other words stay as
 * they are, so `sync` or `status` are never cut short.
 */
export function operationId(op: Pick<ApiOperation, "method" | "path" | "id">): string {
  if (op.id) return op.id;
  const words = op.path
    .replace(/^\/(api|dist)\//, "")
    .split("/")
    .flatMap((part, i, all) => {
      if (!part || part.startsWith("{")) return [];
      const word = part.replace(/\.(json|tgz)$/, "").replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase());
      return [all[i + 1]?.startsWith("{") ? word.replace(/ies$/, "y").replace(/s$/, "") : word];
    });
  return op.method + words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

/** A schema as JSON Schema 2020-12, the dialect OpenAPI 3.1 uses. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: "any" });
  return rest;
}

const ref = (name: AnswerName | RequestName) => ({ $ref: `#/components/schemas/${name}` });

function answer(a: Answer) {
  if (a.binary) return { description: a.description, content: Object.fromEntries(a.binary.map((type) => [type, { schema: { type: "string", contentMediaType: type } }])) };
  if (!a.schema) return { description: a.description };
  const schema = Array.isArray(a.schema) ? { type: "array", items: ref(a.schema[0]) } : ref(a.schema);
  return { description: a.description, content: { "application/json": { schema } } };
}

function parameters(op: ApiOperation) {
  return [
    ...[...op.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({ name, in: "path", required: true, schema: { type: "string" } })),
    ...Object.entries(op.query ?? {}).map(([name, description]) => ({ name, in: "query", required: false, description, schema: { type: "string" } })),
  ];
}

function operation(op: ApiOperation) {
  const params = parameters(op);
  return {
    operationId: operationId(op),
    tags: [op.tag],
    summary: op.summary,
    ...(op.public ? { security: [] } : {}),
    ...(params.length ? { parameters: params } : {}),
    ...(op.body ? { requestBody: { required: !op.optionalBody, content: { "application/json": { schema: ref(op.body) } } } } : {}),
    responses: {
      ...Object.fromEntries(Object.entries(op.responses).map(([status, a]) => [status, answer(a)])),
      ...(op.public ? {} : { 401: { description: "Missing or wrong token" } }),
    },
  };
}

/** The Hub's OpenAPI 3.1 description, built from the shared schemas (`@aso/shared` api.ts). */
export function openApiDocument(version: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) (paths[op.path] ??= {})[op.method] = operation(op);
  const schemas = {
    ...Object.fromEntries(Object.entries(ANSWER_SCHEMAS).map(([name, s]) => [name, jsonSchema(s, "output")])),
    ...Object.fromEntries(Object.entries(REQUEST_SCHEMAS).map(([name, s]) => [name, jsonSchema(s, "input")])),
  };
  return {
    openapi: "3.1.0",
    info: { title: "ASO Hub API", version, license: { name: "MIT", identifier: "MIT" }, description: DESCRIPTION },
    servers: [{ url: "http://{hub}:{port}", description: "Your Hub", variables: { hub: { default: "127.0.0.1" }, port: { default: "7420" } } }],
    components: { securitySchemes: { token: { type: "http", scheme: "bearer", description: "The ASO token" } }, schemas },
    security: [{ token: [] }],
    tags: Object.entries(API_TAGS).map(([name, description]) => ({ name, description })),
    paths,
  };
}
