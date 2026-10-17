import {
  ApiErrorSchema,
  ApproveTaskBodySchema,
  CreatePlanBodySchema,
  CreateProjectBodySchema,
  CreateTaskBodySchema,
  HealthSchema,
  LlmStatusSchema,
  NodeSchema,
  PlanReplyBodySchema,
  PlanSchema,
  ProjectSchema,
  PushCheckSchema,
  PushEndpointSchema,
  PushRemovedSchema,
  PushStatusSchema,
  PushSubscribedSchema,
  PushSubscriptionSchema,
  PushTestResultSchema,
  PushTestSchema,
  RedeemSignInCodeBodySchema,
  RequestChangesBodySchema,
  ReviewChecksSchema,
  SignedInSchema,
  SignInCodeSchema,
  SyncBodySchema,
  SyncStatusSchema,
  TaskDiffSchema,
  TaskSchema,
  TranscriptSchema,
  VersionSchema,
} from "@aso/shared";

/** What clients send: documented as input, so fields with defaults are optional. */
export const REQUEST_SCHEMAS = {
  CreateProject: CreateProjectBodySchema,
  CreatePlan: CreatePlanBodySchema,
  PlanReply: PlanReplyBodySchema,
  CreateTask: CreateTaskBodySchema,
  ApproveTask: ApproveTaskBodySchema,
  RequestChanges: RequestChangesBodySchema,
  Sync: SyncBodySchema,
  RedeemSignInCode: RedeemSignInCodeBodySchema,
  PushSubscription: PushSubscriptionSchema,
  PushEndpoint: PushEndpointSchema,
  PushTest: PushTestSchema,
} as const;

/** What the Hub answers. */
export const ANSWER_SCHEMAS = {
  Error: ApiErrorSchema,
  Version: VersionSchema,
  Health: HealthSchema,
  Node: NodeSchema,
  Project: ProjectSchema,
  SyncStatus: SyncStatusSchema,
  Task: TaskSchema,
  TaskDiff: TaskDiffSchema,
  ReviewChecks: ReviewChecksSchema,
  Plan: PlanSchema,
  Transcript: TranscriptSchema,
  LlmStatus: LlmStatusSchema,
  PushStatus: PushStatusSchema,
  PushSubscribed: PushSubscribedSchema,
  PushCheck: PushCheckSchema,
  PushRemoved: PushRemovedSchema,
  PushTestResult: PushTestResultSchema,
  SignInCode: SignInCodeSchema,
  SignedIn: SignedInSchema,
} as const;

export type RequestName = keyof typeof REQUEST_SCHEMAS;
export type AnswerName = keyof typeof ANSWER_SCHEMAS;

export interface Answer {
  description: string;
  /** A schema, or `[schema]` for a list of them; none for the package download. */
  schema?: AnswerName | [AnswerName];
  binary?: boolean;
}

export interface ApiOperation {
  method: "get" | "post";
  /** OpenAPI style: `/api/tasks/{id}`. */
  path: string;
  tag: string;
  /** Overrides the operationId derived from the path (for a path that names no resource). */
  id?: string;
  summary: string;
  /** Answers without the token (everything else needs it). */
  public?: boolean;
  query?: Record<string, string>;
  body?: RequestName;
  /** The body may be left out (all its fields are optional). */
  optionalBody?: boolean;
  responses: Record<number, Answer>;
}

const ok = (schema: AnswerName | [AnswerName], description = "OK"): Answer => ({ description, schema });
const err = (description: string): Answer => ({ description, schema: "Error" });
const notFound = (what: string) => ({ 404: err(`No such ${what}`) });
/** A POST that acts on one thing and answers with it: missing (404) or not allowed in its state (409). */
const act = (schema: AnswerName, what: string, conflict: string) => ({ 200: ok(schema), ...notFound(what), 409: err(conflict) });
const projectQuery = { project: "Only this project's (default: all)" };
const afterQuery = { after: "Only entries after this seq" };
const noProject = { 400: err("Several projects and none named"), ...notFound("project") };

const HUB: ApiOperation[] = [
  { method: "get", path: "/api/version", tag: "Hub", public: true, summary: "The aso build this Hub serves to other machines", responses: { 200: ok("Version") } },
  {
    method: "get", path: "/dist/aso.tgz", tag: "Hub", id: "getPackage", public: true, summary: "The aso package, for installing and updating machines",
    responses: { 200: { description: "The npm package (gzipped tarball)", binary: true }, 404: err("This Hub serves no package") },
  },
  { method: "get", path: "/api/health", tag: "Hub", public: true, summary: "Liveness, plus details with the token", responses: { 200: ok("Health") } },
  { method: "get", path: "/api/openapi.json", tag: "Hub", public: true, summary: "This description (OpenAPI 3.1)", responses: { 200: { description: "OpenAPI 3.1 document" } } },
  { method: "get", path: "/api/llm", tag: "Hub", summary: "Model configuration, queue and spend", responses: { 200: ok("LlmStatus") } },
];

const PROJECTS: ApiOperation[] = [
  { method: "get", path: "/api/projects", tag: "Projects", summary: "All projects", responses: { 200: ok(["Project"]) } },
  { method: "get", path: "/api/projects/{id}", tag: "Projects", summary: "One project", responses: { 200: ok("Project"), ...notFound("project") } },
  {
    method: "post", path: "/api/projects", tag: "Projects", summary: "Create an empty project (a git repository with one commit)", body: "CreateProject",
    responses: { 201: ok("Project", "Created"), 400: err("Invalid name, or the Hub has no projects root"), 409: err("It exists already") },
  },
  { method: "get", path: "/api/sync", tag: "Projects", summary: "Push status of a project's main", query: projectQuery, responses: { 200: ok("SyncStatus"), ...noProject } },
  {
    method: "post", path: "/api/sync", tag: "Projects", summary: "Push main now, and check pull requests now", query: projectQuery, body: "Sync", optionalBody: true,
    responses: { 200: ok("SyncStatus"), ...noProject },
  },
];

const PLANS: ApiOperation[] = [
  { method: "get", path: "/api/plans", tag: "Plans", summary: "All plans", query: projectQuery, responses: { 200: ok(["Plan"]) } },
  { method: "get", path: "/api/plans/{id}", tag: "Plans", summary: "One plan", responses: { 200: ok("Plan"), ...notFound("plan") } },
  {
    method: "post", path: "/api/plans", tag: "Plans", summary: "Ask the Architect to plan a requirement", body: "CreatePlan",
    responses: { 201: ok("Plan", "Queued for the Architect"), ...noProject, 400: err("Invalid body, or several projects and none named") },
  },
  { method: "post", path: "/api/plans/{id}/approve", tag: "Plans", summary: "Approve a proposed plan: its tasks are queued", responses: act("Plan", "plan", "Not proposed") },
  { method: "post", path: "/api/plans/{id}/reject", tag: "Plans", summary: "Reject a plan", responses: act("Plan", "plan", "Already decided") },
  {
    method: "post", path: "/api/plans/{id}/reply", tag: "Plans", summary: "Answer the Architect's questions, or ask for changes to a proposal", body: "PlanReply",
    responses: { ...act("Plan", "plan", "Not waiting for a reply, or too many replies"), 400: err("Invalid body") },
  },
  { method: "get", path: "/api/plans/{id}/transcript", tag: "Plans", summary: "The Architect's work on a plan, as it happens", query: afterQuery, responses: { 200: ok("Transcript"), ...notFound("plan") } },
];

const TASKS: ApiOperation[] = [
  { method: "get", path: "/api/tasks", tag: "Tasks", summary: "All tasks", query: projectQuery, responses: { 200: ok(["Task"]) } },
  { method: "get", path: "/api/tasks/{id}", tag: "Tasks", summary: "One task", responses: { 200: ok("Task"), ...notFound("task") } },
  {
    method: "post", path: "/api/tasks", tag: "Tasks", summary: "Queue a task directly (without a plan)", body: "CreateTask",
    responses: { 201: ok("Task", "Queued"), ...noProject, 400: err("Invalid task, or several projects and none named"), 409: err("The task id is taken") },
  },
  { method: "post", path: "/api/tasks/{id}/cancel", tag: "Tasks", summary: "Stop a task (closes its pull request)", responses: act("Task", "task", "Finished, or merging right now") },
  { method: "post", path: "/api/tasks/{id}/retry", tag: "Tasks", summary: "Queue a failed or cancelled task again with fresh limits", responses: act("Task", "task", "Not failed or cancelled") },
  {
    method: "get", path: "/api/tasks/{id}/diff", tag: "Tasks", summary: "What the task changes, file by file, against the main it branched from",
    responses: { 200: ok("TaskDiff"), ...notFound("task"), 409: err("No unmerged commit to show") },
  },
  {
    method: "get", path: "/api/tasks/{id}/checks", tag: "Tasks", summary: "The CI checks on the task's pull request",
    responses: { 200: ok("ReviewChecks"), ...notFound("task"), 409: err("Not waiting for review, or no pull request yet"), 502: err("GitHub failed") },
  },
  {
    method: "post", path: "/api/tasks/{id}/approve", tag: "Tasks", summary: "Accept the work: merge its pull request (checks must pass unless forced)", body: "ApproveTask", optionalBody: true,
    responses: { ...act("Task", "task", "Not waiting for review, checks not passing (without force), or it conflicts with main"), 400: err("Invalid body"), 502: err("GitHub failed or refused the merge") },
  },
  {
    method: "post", path: "/api/tasks/{id}/request-changes", tag: "Tasks", summary: "Send the work back to an agent with what should change (a review round)", body: "RequestChanges",
    responses: { ...act("Task", "task", "Not waiting for review, or no pull request yet"), 400: err("No message") },
  },
  { method: "get", path: "/api/tasks/{id}/transcript", tag: "Tasks", summary: "The agent's and QA's work on a task, as it happens", query: afterQuery, responses: { 200: ok("Transcript"), ...notFound("task") } },
];

const WORKERS: ApiOperation[] = [
  { method: "get", path: "/api/nodes", tag: "Workers", summary: "Connected workers and the Architect", responses: { 200: ok(["Node"]) } },
  { method: "post", path: "/api/nodes/{id}/drain", tag: "Workers", summary: "Give a worker no new jobs; current ones finish", responses: act("Node", "worker", "Not allowed now (see actions.why)") },
  { method: "post", path: "/api/nodes/{id}/resume", tag: "Workers", summary: "Give a drained worker jobs again (cancels a waiting restart or update)", responses: act("Node", "worker", "Not allowed now") },
  { method: "post", path: "/api/nodes/{id}/restart", tag: "Workers", summary: "Restart a service-run worker once its jobs are done", responses: act("Node", "worker", "Not allowed now (e.g. started by hand)") },
];

const CONSOLE: ApiOperation[] = [
  { method: "post", path: "/api/sign-in-codes", tag: "Console", summary: "A one-time code that signs a browser in to the console", responses: { 201: ok("SignInCode", "Created") } },
  {
    method: "post", path: "/api/sign-in-codes/redeem", tag: "Console", summary: "Use a sign-in code (the console's server does this)", body: "RedeemSignInCode",
    responses: { 200: ok("SignedIn"), 410: err("Used up or expired") },
  },
  { method: "get", path: "/api/push", tag: "Console", summary: "Web Push key and the number of subscribed devices", responses: { 200: ok("PushStatus") } },
  {
    method: "post", path: "/api/push/subscriptions", tag: "Console", summary: "Turn notifications on for a device", body: "PushSubscription",
    responses: { 201: ok("PushSubscribed", "Subscribed"), 400: err("Invalid subscription") },
  },
  { method: "post", path: "/api/push/subscriptions/check", tag: "Console", summary: "Whether a device has notifications on", body: "PushEndpoint", responses: { 200: ok("PushCheck"), 400: err("Invalid body") } },
  { method: "post", path: "/api/push/subscriptions/delete", tag: "Console", summary: "Turn notifications off for a device", body: "PushEndpoint", responses: { 200: ok("PushRemoved"), 400: err("Invalid body") } },
  {
    method: "post", path: "/api/push/test", tag: "Console", summary: "Send a test notification to one device or all", body: "PushTest", optionalBody: true,
    responses: { 200: ok("PushTestResult", "Sent"), 404: err("No (such) subscribed device"), 502: ok("PushTestResult", "No device took it") },
  },
];

/** Every HTTP route under /api and /dist. The WebSocket (/ws) and Git (/git/<project>.git) endpoints speak their own protocols. */
export const API_OPERATIONS: readonly ApiOperation[] = [...HUB, ...PROJECTS, ...PLANS, ...TASKS, ...WORKERS, ...CONSOLE];

export const API_TAGS: Record<string, string> = {
  Hub: "The Hub itself: version, health, model status",
  Projects: "Projects (one git repository each), and pushing their main",
  Plans: "Requirements the Architect turns into tasks, and the conversation about them",
  Tasks: "Units of work an agent implements, QA tests and a person (or the Hub) merges",
  Workers: "The machines that run jobs, and draining or restarting them",
  Console: "Signing browsers in and phone notifications",
};
