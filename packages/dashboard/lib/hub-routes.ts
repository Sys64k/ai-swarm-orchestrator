/**
 * The Hub endpoints the console may reach through its proxy. Anything else (node registration,
 * Git, package downloads) stays out of reach of the browser.
 */
const ID = "[A-Za-z0-9_-]{1,128}";

/** What the console can ask of a worker (`POST nodes/<id>/<action>`). */
export const WORKER_ACTIONS = ["drain", "resume", "restart"] as const;
export type WorkerAction = (typeof WORKER_ACTIONS)[number];
/** Node ids carry the hostname, so dots and colons too; never a `.` or `..` segment. */
/** A provider's name on the Hub (lower-case letters, digits, . _ -). */
export const PROVIDER_ID = "[a-z0-9][a-z0-9._-]{0,39}";
const NODE_ID = "(?!\\.\\.?/)[A-Za-z0-9._:-]{1,128}";
const RULES: ReadonlyArray<{ method: "GET" | "POST"; pattern: RegExp }> = [
  { method: "GET", pattern: /^health$/ },
  // Signed-in devices may create sign-in links for other devices; redeeming is server-side only.
  { method: "POST", pattern: /^sign-in-codes$/ },
  // Push notifications: this device's subscription and a test message.
  { method: "GET", pattern: /^push$/ },
  { method: "POST", pattern: /^push\/(subscriptions|subscriptions\/check|subscriptions\/delete|test)$/ },
  { method: "GET", pattern: /^projects$/ },
  { method: "POST", pattern: /^projects$/ },
  { method: "GET", pattern: new RegExp(`^projects/${ID}$`) },
  { method: "POST", pattern: new RegExp(`^projects/${ID}/deploy$`) },
  { method: "GET", pattern: /^hub\/update$/ },
  { method: "GET", pattern: /^llm$/ },
  { method: "GET", pattern: /^models$/ },
  { method: "GET", pattern: /^desks$/ },
  { method: "GET", pattern: /^track-records$/ },
  { method: "GET", pattern: /^model-suggestions$/ },
  // Model providers: added with a key (it passes through, and is never returned), and prices.
  { method: "GET", pattern: /^providers$/ },
  { method: "POST", pattern: /^providers$/ },
  { method: "POST", pattern: new RegExp(`^providers/${PROVIDER_ID}/remove$`) },
  { method: "GET", pattern: /^prices$/ },
  { method: "POST", pattern: /^prices(\/remove)?$/ },
  { method: "POST", pattern: /^desks$/ },
  { method: "POST", pattern: /^models\/roles$/ },
  { method: "POST", pattern: /^models\/escalation$/ },
  { method: "POST", pattern: /^models\/challengers$/ },
  { method: "GET", pattern: /^tuning$/ },
  { method: "POST", pattern: /^tuning$/ },
  { method: "GET", pattern: /^nodes$/ },
  { method: "POST", pattern: new RegExp(`^nodes/${NODE_ID}/(${WORKER_ACTIONS.join("|")})$`) },
  { method: "GET", pattern: /^version$/ },
  { method: "GET", pattern: /^worker-keys$/ },
  { method: "POST", pattern: /^worker-keys\/join-codes$/ },
  { method: "POST", pattern: new RegExp(`^worker-keys/${ID}/revoke$`) },
  // Trusting or untrusting a machine; projects and budgets are set with `aso worker-key set`.
  // Key ids are 8 hex characters, so this never matches `join` or `join-codes`.
  { method: "POST", pattern: /^worker-keys\/[0-9a-f]{8}$/ },
  { method: "GET", pattern: /^tasks$/ },
  { method: "GET", pattern: new RegExp(`^tasks/${ID}$`) },
  { method: "GET", pattern: new RegExp(`^tasks/${ID}/(transcript|diff|checks)$`) },
  // A QA screenshot; names start with a letter or digit, so never `.` or `..`.
  { method: "GET", pattern: new RegExp(`^tasks/${ID}/screenshots/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`) },
  { method: "POST", pattern: new RegExp(`^tasks/${ID}/(cancel|retry|approve|request-changes)$`) },
  { method: "GET", pattern: /^plans$/ },
  { method: "POST", pattern: /^plans$/ },
  { method: "GET", pattern: new RegExp(`^plans/${ID}$`) },
  { method: "GET", pattern: new RegExp(`^plans/${ID}/transcript$`) },
  { method: "POST", pattern: new RegExp(`^plans/${ID}/(approve|reject|reply)$`) },
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
