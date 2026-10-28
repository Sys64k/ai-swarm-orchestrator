import {
  ApiErrorSchema,
  ApproveTaskBodySchema,
  CreatePlanBodySchema,
  CreateProjectBodySchema,
  CreateTaskBodySchema,
  DiscoveryProofBodySchema,
  DeskAssignmentBodySchema,
  ProviderAddBodySchema,
  ProviderViewSchema,
  ProviderRemovedSchema,
  PriceRemoveBodySchema,
  PriceSetBodySchema,
  PriceSchema,
  PricesSchema,
  DesksSchema,
  RoleModelBodySchema,
  EscalationBodySchema,
  ChallengerBodySchema,
  TuningBodySchema,
  TuningViewSchema,
  TrackRecordsSchema,
  ModelSuggestionsSchema,
  PublicStatsSchema,
  ModelsSchema,
  DiscoveryProofSchema,
  DeployNextSchema,
  DeployResultAcceptedSchema,
  HubUpdateReportBodySchema,
  HubUpdateSchema,
  DeployResultBodySchema,
  DeployStartedSchema,
  IMAGE_MEDIA_TYPES,
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
  JoinBodySchema,
  JoinCodeBodySchema,
  WorkerKeyScopeBodySchema,
  JoinCodeSchema,
  WorkerKeyJoinedSchema,
  WorkerKeySchema,
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
  DeployResult: DeployResultBodySchema,
  HubUpdateReport: HubUpdateReportBodySchema,
  RedeemSignInCode: RedeemSignInCodeBodySchema,
  JoinCode: JoinCodeBodySchema,
  WorkerKeyScope: WorkerKeyScopeBodySchema,
  Join: JoinBodySchema,
  DiscoveryProofBody: DiscoveryProofBodySchema,
  DeskAssignment: DeskAssignmentBodySchema,
  RoleModel: RoleModelBodySchema,
  Escalation: EscalationBodySchema,
  Challenger: ChallengerBodySchema,
  Tuning: TuningBodySchema,
  ProviderAdd: ProviderAddBodySchema,
  PriceSet: PriceSetBodySchema,
  PriceRemove: PriceRemoveBodySchema,
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
  DeployStarted: DeployStartedSchema,
  DeployNext: DeployNextSchema,
  DeployResultAccepted: DeployResultAcceptedSchema,
  HubUpdate: HubUpdateSchema,
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
  JoinCode: JoinCodeSchema,
  WorkerKeyJoined: WorkerKeyJoinedSchema,
  WorkerKey: WorkerKeySchema,
  DiscoveryProof: DiscoveryProofSchema,
  Models: ModelsSchema,
  Desks: DesksSchema,
  TrackRecords: TrackRecordsSchema,
  ModelSuggestions: ModelSuggestionsSchema,
  TuningView: TuningViewSchema,
  PublicStats: PublicStatsSchema,
  Provider: ProviderViewSchema,
  ProviderRemoved: ProviderRemovedSchema,
  Price: PriceSchema,
  Prices: PricesSchema,
  SignedIn: SignedInSchema,
} as const;

export type RequestName = keyof typeof REQUEST_SCHEMAS;
export type AnswerName = keyof typeof ANSWER_SCHEMAS;

export interface Answer {
  description: string;
  /** A schema, or `[schema]` for a list of them; none for a file download. */
  schema?: AnswerName | [AnswerName];
  /** A file instead of JSON: the media types it may have. */
  binary?: readonly string[];
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
    method: "get", path: "/api/public-stats", tag: "Hub", public: true,
    summary: "The swarm's track record as this Hub shares it publicly (totals; per model and costs if it chose to)",
    responses: { 200: ok("PublicStats"), 404: err("This Hub doesn't share its stats") },
  },
  { method: "get", path: "/api/hub/update", tag: "Hub", summary: "Where the Hub's own update from its repository stands", responses: { 200: ok("HubUpdate") } },
  {
    method: "post", path: "/api/hub/update", tag: "Hub", summary: "For the updater on the Hub machine: report where the Hub's update stands", body: "HubUpdateReport",
    responses: { 200: ok("HubUpdate"), 400: err("Invalid body") },
  },
  {
    method: "get", path: "/dist/aso.tgz", tag: "Hub", id: "getPackage", public: true, summary: "The aso package, for installing and updating machines",
    responses: { 200: { description: "The npm package (gzipped tarball)", binary: ["application/gzip"] }, 404: err("This Hub serves no package") },
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
  {
    method: "post", path: "/api/projects/{id}/deploy", tag: "Projects", summary: "Deploy the project's main now with its command from the Hub's deploy.json",
    responses: { 202: ok("DeployStarted", "Deploying (or queued after the deploy in progress)"), ...notFound("project"), 409: err("No deploy command for this project") },
  },
  {
    method: "get", path: "/api/deploys/next", tag: "Projects", summary: "For the host runner of a Hub in a container: take the next deploy job",
    responses: { 200: ok("DeployNext"), 404: err("This Hub runs deploys itself") },
  },
  {
    method: "post", path: "/api/deploys/{id}/result", tag: "Projects", summary: "For the host runner: report how a deploy job it took went", body: "DeployResult",
    responses: { 200: ok("DeployResultAccepted"), 400: err("Invalid body"), 404: err("No such job waiting for a result") },
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
  {
    method: "get", path: "/api/track-records", tag: "Tasks", summary: "How models, machines, desks, roles or projects have done with their jobs",
    query: {
      by: "Group by model (default), host, desk, role or project",
      project: "Only this project's tasks",
      role: "Only tasks of this role",
      model: "Only this model's work, by its name as the records keep it: its builds, the tasks it started and finished, its plans and acceptance checks (no QA runs)",
      since: "Only jobs started at or after this time (ISO 8601)",
    },
    responses: { 200: ok("TrackRecords"), 400: err("A bad grouping or time") },
  },
  {
    method: "get", path: "/api/model-suggestions", tag: "Tasks", summary: "Which model each role (desks, reviewer, Architect) would do as well on for less, or clearly better on, from the track records",
    query: { since: "Compare jobs started at or after this time (ISO 8601; default: the last 30 days)" },
    responses: { 200: ok("ModelSuggestions"), 400: err("A bad time") },
  },
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
  {
    method: "get", path: "/api/tasks/{id}/screenshots/{name}", tag: "Tasks", summary: "One screenshot from the task's last passing QA run (listed in the task's screenshots)",
    responses: { 200: { description: "The image", binary: IMAGE_MEDIA_TYPES }, 404: err("No such task, or it has no screenshot of that name") },
  },
];

const WORKERS: ApiOperation[] = [
  { method: "get", path: "/api/nodes", tag: "Workers", summary: "Connected workers and the Architect", responses: { 200: ok(["Node"]) } },
  { method: "post", path: "/api/nodes/{id}/drain", tag: "Workers", summary: "Give a worker no new jobs; current ones finish", responses: act("Node", "worker", "Not allowed now (see actions.why)") },
  { method: "post", path: "/api/nodes/{id}/resume", tag: "Workers", summary: "Give a drained worker jobs again (cancels a waiting restart or update)", responses: act("Node", "worker", "Not allowed now") },
  { method: "post", path: "/api/nodes/{id}/restart", tag: "Workers", summary: "Restart a service-run worker once its jobs are done", responses: act("Node", "worker", "Not allowed now (e.g. started by hand)") },
  {
    method: "post", path: "/api/worker-keys/join-codes", tag: "Workers", summary: "A one-time code (30 min) a new worker machine trades for its own key", body: "JoinCode", optionalBody: true,
    responses: { 201: ok("JoinCode", "Created"), 400: err("Invalid body") },
  },
  {
    method: "post", path: "/api/worker-keys/join", tag: "Workers", public: true, summary: "For a joining machine: trade a join code for a worker key (worker work only: /ws and Git)", body: "Join",
    responses: { 201: ok("WorkerKeyJoined", "Joined"), 400: err("Invalid body"), 403: err("Unknown, used or expired code"), 429: err("Too many failed attempts") },
  },
  { method: "get", path: "/api/worker-keys", tag: "Workers", summary: "The worker keys, revoked ones included", responses: { 200: ok(["WorkerKey"]) } },
  {
    method: "post", path: "/api/worker-keys/{id}", tag: "Workers", summary: "Change what a worker key may do: its projects, whether its machine is trusted, its model budget", body: "WorkerKeyScope",
    responses: { 200: ok("WorkerKey"), 400: err("Invalid body, or an unknown project"), 404: err("No such key") },
  },
  {
    method: "post", path: "/api/worker-keys/{id}/revoke", tag: "Workers", summary: "Revoke a worker key: its machine is disconnected and can't come back with it",
    responses: { 200: ok("WorkerKey"), 404: err("No such key") },
  },
  {
    method: "post", path: "/api/discovery/proof", tag: "Workers",
    summary: "For the Hub machine's LAN discovery: prove the Hub holds the credential a worker's query names (its token, a worker key or a join code)", body: "DiscoveryProofBody",
    responses: { 200: ok("DiscoveryProof"), 400: err("Invalid body"), 404: err("No credential with that id") },
  },
  { method: "get", path: "/api/models", tag: "Workers", summary: "The models desks can use (Claude, and the local OpenAI-compatible server's), and the Architect's and default ones", responses: { 200: ok("Models") } },
  { method: "get", path: "/api/providers", tag: "Workers", summary: "The model providers (added ones and the .env's), with how many models each lists; never a key", responses: { 200: ok(["Provider"]) } },
  {
    method: "post", path: "/api/providers", tag: "Workers", summary: "Add (or replace) a provider with its key or address; its model list is fetched first, so a wrong key is refused", body: "ProviderAdd",
    responses: { 201: ok("Provider", "Added"), 400: err("Invalid body, or the provider refused the key or can't be reached") },
  },
  {
    method: "post", path: "/api/providers/{id}/remove", tag: "Workers", summary: "Remove an added provider and forget its key",
    responses: { 200: ok("ProviderRemoved"), 404: err("No such provider"), 409: err("It comes from the Hub's .env") },
  },
  { method: "get", path: "/api/prices", tag: "Workers", summary: "Model prices: the built-in ones and those set on this Hub (USD per million tokens)", responses: { 200: ok("Prices") } },
  {
    method: "post", path: "/api/prices", tag: "Workers", summary: "Set a model's price, so task budgets stop it too; it wins over a built-in or reported one", body: "PriceSet",
    responses: { 200: ok("Price"), 400: err("Invalid body") },
  },
  {
    method: "post", path: "/api/prices/remove", tag: "Workers", summary: "Remove a price set on this Hub", body: "PriceRemove",
    responses: { 200: ok("Prices"), 400: err("Invalid body"), 404: err("No price set for it") },
  },
  {
    method: "post", path: "/api/models/roles", tag: "Workers", summary: "Put the Architect or the reviewer (the acceptance check) on a model, or back on the default", body: "RoleModel",
    responses: { 200: ok("Desks"), 400: err("Not a model the Hub can use for it") },
  },
  { method: "get", path: "/api/tuning", tag: "Workers", summary: "Each role's model pool (its own model, the members and their shares), auto-tuning, and what it changed", responses: { 200: ok("TuningView") } },
  {
    method: "post", path: "/api/tuning", tag: "Workers", summary: "Turn a role's auto-tuning on or off, or set the models it tries next", body: "Tuning",
    responses: { 200: ok("TuningView"), 400: err("Not a model the Hub can try, or an invalid body") },
  },
  {
    method: "post", path: "/api/models/challengers", tag: "Workers", summary: "Put a model on trial for the desks or the reviewer: it takes a share of the work within a budget, until suggestions can compare it; model none ends it", body: "Challenger",
    responses: { 200: ok("Desks"), 400: err("Not a model the Hub can use for it, or an invalid body") },
  },
  {
    method: "post", path: "/api/models/escalation", tag: "Workers", summary: "Change where failing tasks move: the ladder of stronger models, the tries on a desk's model before it, or either back to the Hub's start setting", body: "Escalation",
    responses: { 200: ok("Desks"), 400: err("Not a model the Hub can use for it, or an invalid body") },
  },
  { method: "get", path: "/api/desks", tag: "Workers", summary: "Which desks use a model of their own, and each such model's calls at once and load", responses: { 200: ok("Desks") } },
  {
    method: "post", path: "/api/desks", tag: "Workers", summary: "Put a desk (<host>#<slot>) or a whole machine (<host>) on a model, or back on the default", body: "DeskAssignment",
    responses: { 200: ok("Desks"), 400: err("Invalid body, unknown model, or a model the Hub can't use"), 404: err("That machine isn't connected") },
  },
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
