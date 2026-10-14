/**
 * The Hub endpoints the console may reach through its proxy. Anything else (node registration,
 * Git, package downloads) stays out of reach of the browser.
 */
const ID = "[A-Za-z0-9_-]{1,128}";
const RULES: ReadonlyArray<{ method: "GET" | "POST"; pattern: RegExp }> = [
  { method: "GET", pattern: /^health$/ },
  { method: "GET", pattern: /^llm$/ },
  { method: "GET", pattern: /^nodes$/ },
  { method: "GET", pattern: /^tasks$/ },
  { method: "GET", pattern: new RegExp(`^tasks/${ID}$`) },
  { method: "GET", pattern: new RegExp(`^tasks/${ID}/transcript$`) },
  { method: "POST", pattern: new RegExp(`^tasks/${ID}/(cancel|retry)$`) },
  { method: "GET", pattern: /^plans$/ },
  { method: "POST", pattern: /^plans$/ },
  { method: "GET", pattern: new RegExp(`^plans/${ID}$`) },
  { method: "GET", pattern: new RegExp(`^plans/${ID}/transcript$`) },
  { method: "POST", pattern: new RegExp(`^plans/${ID}/(approve|reject)$`) },
];

/** A readable message for a failed response: the API's `error` field, or the status. */
export function errorMessage(status: number, body: unknown): string {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === "string" && error ? error : `HTTP ${status}`;
}

/** The Hub path (`/api/...`) for an allowed request, or undefined. */
export function hubPath(method: string, segments: readonly string[]): string | undefined {
  const joined = segments.join("/");
  return RULES.some((r) => r.method === method && r.pattern.test(joined)) ? `/api/${joined}` : undefined;
}
