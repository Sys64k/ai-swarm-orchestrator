import { createHash } from "node:crypto";
import { z } from "zod";
import { createLogger, type TaskSpec } from "@aso/shared";
import type { Project } from "./projects.js";

const log = createLogger("api-sync");

/** Where a project keeps its copy of the Hub's API description. */
export const API_COPY_PATH = "docs/openapi.json";
/** At most this many of each kind of change are named in a sync task. */
const LISTED = 40;
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

/** The parts of an API description the sync reads; the rest is kept as it is. */
const OpenApiSchema = z.looseObject({
  info: z.looseObject({ title: z.string().optional(), version: z.string().optional() }).optional(),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  components: z.looseObject({ schemas: z.record(z.string(), z.unknown()).optional() }).optional(),
});
type OpenApi = z.infer<typeof OpenApiSchema>;

/** JSON with object keys sorted: two descriptions that differ only in key order compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}

export interface ApiChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

/** The API description as it is written to a file (as `npm run openapi` writes it). */
export function apiFileContents(doc: object): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Names a version of the API description, whatever its key order. */
export function apiHash(doc: object): string {
  return createHash("sha256").update(canonical(doc)).digest("hex");
}

/** The sync task of one project for one version of the description (task ids are unique across projects). */
/** What every sync task's id starts with. */
export const SYNC_TASK_PREFIX = "sync-hub-api-";

export function syncTaskId(projectId: string, hash: string): string {
  return `${SYNC_TASK_PREFIX}${createHash("sha256").update(`${projectId}:${hash}`).digest("hex").slice(0, 12)}`;
}

/** What differs between two API descriptions: operations (`POST /api/x`) and schemas (`schema X`). */
export function apiChanges(before: OpenApi, after: OpenApi): ApiChanges {
  const items = (doc: OpenApi) => {
    const out = new Map<string, string>();
    for (const [route, ops] of Object.entries(doc.paths ?? {})) {
      for (const method of METHODS) if (ops[method] !== undefined) out.set(`${method.toUpperCase()} ${route}`, JSON.stringify(ops[method]));
    }
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) out.set(`schema ${name}`, JSON.stringify(schema));
    return out;
  };
  const was = items(before);
  const now = items(after);
  return {
    added: [...now.keys()].filter((k) => !was.has(k)),
    removed: [...was.keys()].filter((k) => !now.has(k)),
    changed: [...now.keys()].filter((k) => was.has(k) && was.get(k) !== now.get(k)),
  };
}

/** The task that brings a project's copy up to date (its branch already holds the new copy). */
export function syncTaskSpec(taskId: string, version: string, changes: ApiChanges): TaskSpec {
  const list = (what: string, names: string[]) =>
    names.length ? [`- ${what}: ${names.slice(0, LISTED).join(", ")}${names.length > LISTED ? `, and ${names.length - LISTED} more` : ""}`] : [];
  const what = [...list("Added", changes.added), ...list("Removed", changes.removed), ...list("Changed", changes.changed)];
  return {
    taskId,
    role: "frontend",
    kind: "feature",
    title: "Sync the Hub API description",
    description: [
      `The Hub's API changed, and this project keeps a copy of its description in ${API_COPY_PATH}. This task's branch already has the new copy (Hub API ${version}) as its first commit: start from it.`,
      "",
      "What changed:",
      ...(what.length ? what : ["- Descriptions and details only"]),
      "",
      "Do:",
      `1. Regenerate whatever the project derives from ${API_COPY_PATH}, with its own script if it has one (look in package.json, e.g. one that runs openapi-typescript).`,
      "2. Fix what no longer compiles or passes because of the change: types, mock data and test fixtures that miss new required fields, calls to removed or changed endpoints.",
      "3. Nothing more: don't build features on new endpoints and don't change behaviour beyond what the change requires. New features are planned separately.",
      "",
      `Keep ${API_COPY_PATH} exactly as it is on this branch.`,
    ].join("\n"),
    acceptanceCriteria: [
      `${API_COPY_PATH} isn't changed in the diff (the Hub's own first commit on this branch put the new copy there, and the diff starts after it)`,
      `Files generated from ${API_COPY_PATH} are regenerated from it`,
      // Only what the diff can show: the acceptance check reads the diff, so "typecheck and lint
      // pass" would stay unclear and keep the sync from merging itself. QA runs the tests, and
      // auto-merge waits for the project's CI (typecheck, lint, the rest).
      "Nothing beyond what the API change requires is changed: no new features, no unrelated edits",
    ],
    files: [API_COPY_PATH],
    dependsOn: [],
  };
}

/** The project's copy of the description on main, when it has one and it differs from `doc`. */
async function outdatedCopy(project: Project, doc: OpenApi): Promise<OpenApi | undefined> {
  const main = await project.repo.mainHead();
  const copy = main ? await project.repo.readFileAt(main, API_COPY_PATH) : undefined;
  if (copy === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(copy);
  } catch {
    parsed = undefined;
  }
  const theirs = OpenApiSchema.safeParse(parsed);
  if (!theirs.success) {
    log.warn(`project ${project.id}: ${API_COPY_PATH} is not an API description; not syncing it`);
    return undefined;
  }
  if (theirs.data.info?.title !== doc.info?.title) return undefined; // another API's description
  return canonical(theirs.data) === canonical(doc) ? undefined : theirs.data;
}

/** The copy is out of date, also after catching up with GitHub (where it may have been synced by hand). */
async function stillOutdated(project: Project, doc: OpenApi, catchUp?: (project: Project) => Promise<void>): Promise<OpenApi | undefined> {
  if (!(await outdatedCopy(project, doc))) return undefined;
  if (catchUp) await catchUp(project);
  return outdatedCopy(project, doc);
}

/**
 * For each project that keeps a copy of this Hub's API description (`docs/openapi.json` with the
 * same title) and whose copy differs: put the new description on a task branch and queue a task
 * that regenerates and fixes what depends on it. Once per project and version of the description:
 * both are in the task id, so a task that was cancelled is not queued again. Never throws.
 */
export async function syncApiCopies(
  projects: readonly Project[],
  doc: OpenApi & object,
  catchUp?: (project: Project) => Promise<void>,
  opts: { autoMerge?: boolean } = {},
): Promise<void> {
  const contents = apiFileContents(doc);
  const hash = apiHash(doc);
  const version = doc.info?.version ?? "new";
  for (const project of projects) {
    const taskId = syncTaskId(project.id, hash);
    try {
      const earlier = project.tasks.get(taskId);
      if (earlier) {
        if (await outdatedCopy(project, doc)) log.info(`project ${project.id}: its copy of the Hub API description is out of date; ${taskId} was queued for it before (${earlier.state})`);
        continue;
      }
      const theirs = await stillOutdated(project, doc, catchUp);
      if (!theirs) continue;
      const seeded = await project.repo.seedTaskBranch(taskId, { [API_COPY_PATH]: contents }, `chore: sync the Hub API description (${version})`);
      try {
        // The acceptance check judges the agent's work after the Hub's own commit of the copy.
        project.tasks.submit(syncTaskSpec(taskId, version, apiChanges(theirs, doc)), { diffBase: seeded, ...(opts.autoMerge ? { autoMerge: true } : {}) });
        // Older syncs of this project's copy would bring an older description: this one replaces them.
        for (const older of project.tasks.list()) {
          if (older.spec.taskId !== taskId && older.spec.taskId.startsWith(SYNC_TASK_PREFIX)) project.tasks.supersede(older.spec.taskId, taskId);
        }
      } catch (err) {
        await project.repo.deleteTaskBranch(taskId);
        throw err;
      }
      log.info(`project ${project.id}: its copy of the Hub API description is out of date; queued ${taskId}`);
    } catch (err) {
      log.warn(`project ${project.id}: could not queue a sync of the Hub API description: ${(err as Error).message}`);
    }
  }
}
