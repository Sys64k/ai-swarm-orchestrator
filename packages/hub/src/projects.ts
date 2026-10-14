import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger, ProjectIdSchema, type LlmUsage } from "@aso/shared";
import { DependencyManager, type DependencyManagerOptions } from "./dependencies.js";
import { HubRepository } from "./git/hub-repo.js";
import { GitSync } from "./git/sync.js";
import { PlanManager, type PlanRecord } from "./plans.js";
import type { NodeRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import { TaskManager, type AgentTurn, type TaskManagerOptions, type TaskRecord } from "./tasks.js";
import { Transcripts, type TranscriptInput, type TranscriptSubject } from "./transcripts.js";

const log = createLogger("projects");
const exec = promisify(execFile);

/** Everything the Hub keeps for one project; each project's state lives in its own `.git/aso/`. */
export interface Project {
  id: string;
  dir: string;
  repo: HubRepository;
  tasks: TaskManager;
  plans: PlanManager;
  deps: DependencyManager;
  sync: GitSync;
  transcripts: Transcripts;
  store?: StateStore;
}

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "conflict" | "invalid",
  ) {
    super(message);
  }
}

export interface ProjectSetOptions {
  /** Folder holding the projects (one git repository per sub-folder). Undefined: only `single`. */
  root?: string;
  /** A single project directory, served as id `project` (the pre-projects mode, used by tests). */
  single?: string;
  mainBranch?: string;
  /** `false` keeps each project's state in memory only. */
  persist?: boolean;
  tasks: Pick<TaskManagerOptions, "policies" | "reclaimGraceMs" | "qa">;
  deps: Pick<DependencyManagerOptions, "installer" | "allow">;
  sync: { enabled?: boolean; remote?: string; token?: string; retryMs?: number };
}

/**
 * The Hub's projects. They share the workers and the Architect: dispatching is Hub-wide, task and
 * plan ids are unique across projects, and lookups by id find the owning project.
 */
export class ProjectSet {
  private readonly projects = new Map<string, Project>();
  /** Rotates which project dispatches first, so one busy project can't starve the others. */
  private dispatchOffset = 0;

  private constructor(
    private readonly registry: NodeRegistry,
    private readonly opts: ProjectSetOptions,
  ) {}

  /** Open every project: the single directory, or each git repository directly under the root. */
  static async open(registry: NodeRegistry, opts: ProjectSetOptions): Promise<ProjectSet> {
    const set = new ProjectSet(registry, opts);
    if (opts.single) await set.add("project", opts.single);
    if (opts.root) {
      await mkdir(opts.root, { recursive: true });
      for (const entry of (await readdir(opts.root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (!ProjectIdSchema.safeParse(entry.name).success) {
          log.warn(`skipping ${entry.name}: project folder names must be lowercase letters, digits, dashes or underscores`);
          continue;
        }
        const dir = path.join(opts.root, entry.name);
        if (!existsSync(path.join(dir, ".git"))) {
          log.info(`skipping ${entry.name}: not a git repository`);
          continue;
        }
        try {
          await set.add(entry.name, dir);
        } catch (err) {
          log.warn(`skipping ${entry.name}: ${(err as Error).message}`);
        }
      }
    }
    log.info(`${set.projects.size} project(s): ${[...set.projects.keys()].join(", ") || "none yet"}`);
    return set;
  }

  get root(): string | undefined {
    return this.opts.root;
  }

  list(): Project[] {
    return [...this.projects.values()];
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /** The project a request without one means: the only one there is. */
  resolve(id: unknown): Project {
    if (id !== undefined) {
      const project = typeof id === "string" ? this.projects.get(id) : undefined;
      if (!project) throw new ProjectError(`project ${String(id)} not found`, "not_found");
      return project;
    }
    if (this.projects.size === 1) return this.list()[0];
    throw new ProjectError(this.projects.size ? "say which project (`project`)" : "create a project first", "invalid");
  }

  /** Create `<root>/<name>` as a new git repository with an empty first commit, and open it. */
  async create(name: unknown): Promise<Project> {
    if (!this.opts.root) throw new ProjectError("this Hub has no projects root, so it cannot create projects", "invalid");
    const parsed = ProjectIdSchema.safeParse(name);
    if (!parsed.success) throw new ProjectError(parsed.error.issues[0].message, "invalid");
    const id = parsed.data;
    const dir = path.join(this.opts.root, id);
    if (this.projects.has(id) || existsSync(dir)) throw new ProjectError(`${id} already exists in ${this.opts.root}`, "conflict");
    const branch = this.opts.mainBranch ?? "main";
    await mkdir(dir);
    await exec("git", ["init", "--quiet", `--initial-branch=${branch}`], { cwd: dir });
    await exec("git", ["-c", "user.name=ASO Hub", "-c", "user.email=aso-hub@localhost", "commit", "--quiet", "--allow-empty", "-m", "Initial commit"], { cwd: dir });
    log.info(`created project ${id} in ${dir}`);
    return this.add(id, dir);
  }

  /** Give idle workers and Architects work from every project. */
  dispatchAll(): void {
    const all = this.list();
    if (!all.length) return;
    this.dispatchOffset = (this.dispatchOffset + 1) % all.length;
    for (let i = 0; i < all.length; i++) {
      const p = all[(this.dispatchOffset + i) % all.length];
      p.tasks.dispatch();
      p.plans.dispatch();
    }
  }

  taskOwner(taskId: string): Project | undefined {
    return this.list().find((p) => p.tasks.get(taskId));
  }

  planOwner(planId: string): Project | undefined {
    return this.list().find((p) => p.plans.get(planId));
  }

  /** Hub-wide view of tasks, by globally unique id (what the LLM gateway and the API need). */
  readonly tasks = {
    list: (): TaskRecord[] => this.list().flatMap((p) => p.tasks.list()),
    get: (taskId: string): TaskRecord | undefined => this.taskOwner(taskId)?.tasks.get(taskId),
    dispatch: (): void => this.dispatchAll(),
    isImplementing: (nodeId: string, taskId: string): boolean => !!this.taskOwner(taskId)?.tasks.isImplementing(nodeId, taskId),
    isHeldFor: (nodeId: string, taskId: string): boolean => !!this.taskOwner(taskId)?.tasks.isHeldFor(nodeId, taskId),
    spentSinceRetry: (taskId: string): number => this.taskOwner(taskId)?.tasks.spentSinceRetry(taskId) ?? 0,
    recordLlmUsage: (taskId: string, usage: LlmUsage): void => this.taskOwner(taskId)?.tasks.recordLlmUsage(taskId, usage),
    recordAgentTurn: (taskId: string, turn: Omit<AgentTurn, "at">): void => this.taskOwner(taskId)?.tasks.recordAgentTurn(taskId, turn),
    recordEvent: (taskId: string, event: string): void => this.taskOwner(taskId)?.tasks.recordEvent(taskId, event),
  };

  /** Hub-wide view of plans, by globally unique id. */
  readonly plans = {
    list: (): PlanRecord[] => this.list().flatMap((p) => p.plans.list()),
    get: (planId: string): PlanRecord | undefined => this.planOwner(planId)?.plans.get(planId),
    isPlanning: (nodeId: string, planId: string): boolean => !!this.planOwner(planId)?.plans.isPlanning(nodeId, planId),
    recordLlmUsage: (planId: string, usage: LlmUsage): void => this.planOwner(planId)?.plans.recordLlmUsage(planId, usage),
    recordAgentTurn: (planId: string, turn: Omit<AgentTurn, "at">): void => this.planOwner(planId)?.plans.recordAgentTurn(planId, turn),
    recordEvent: (planId: string, event: string): void => this.planOwner(planId)?.plans.recordEvent(planId, event),
  };

  /** Transcripts, routed to the project that owns the task or plan. */
  readonly transcripts = {
    append: (subject: TranscriptSubject, entry: TranscriptInput): void => this.ownerOf(subject)?.transcripts.append(subject, entry),
    read: (subject: TranscriptSubject, after?: number) => this.ownerOf(subject)?.transcripts.read(subject, after) ?? { entries: [], last: -1 },
  };

  /** Write pending state and transcripts; later changes stay in memory (the Hub is stopping). */
  async close(): Promise<void> {
    for (const p of this.list()) {
      p.sync.stop();
      await p.store?.close();
      await p.transcripts.close();
    }
  }

  private ownerOf(subject: TranscriptSubject): Project | undefined {
    return subject.kind === "task" ? this.taskOwner(subject.id) : this.planOwner(subject.id);
  }

  private async add(id: string, dir: string): Promise<Project> {
    const repo = await HubRepository.open(dir, this.opts.mainBranch);
    const store = this.opts.persist === false ? undefined : new StateStore(path.join(await repo.gitDir(), "aso"));
    const saved = await store?.load<TaskRecord, PlanRecord>();
    const transcripts = new Transcripts(store ? path.join(store.dir, "transcripts") : undefined);
    const sync = await GitSync.create(repo, { ...this.opts.sync, enabled: this.opts.sync.enabled ?? true });
    // Filled in below; the managers' callbacks only run after construction.
    const project = { id, dir, repo, sync, transcripts, store } as Project;
    const persist = () => store?.scheduleSave(() => ({ tasks: project.tasks.list(), plans: project.plans.list() }));
    /** Merged tasks waiting for their commits to reach the remote. */
    const unpushed = new Set<string>();

    project.tasks = new TaskManager(this.registry, repo, {
      ...this.opts.tasks,
      project: id,
      onDispatchNeeded: () => this.dispatchAll(),
      isIdTaken: (taskId) => !!this.taskOwner(taskId),
      onMerged: (task) => {
        if (!sync.status().enabled) return;
        unpushed.add(task.spec.taskId);
        void sync.requestPush();
      },
      onChange: persist,
      onTranscript: (taskId, entry) => transcripts.append({ kind: "task", id: taskId }, entry),
    });
    project.plans = new PlanManager(
      this.registry,
      project.tasks,
      persist,
      (planId, entry) => transcripts.append({ kind: "plan", id: planId }, entry),
      () => this.dispatchAll(),
    );
    project.deps = new DependencyManager(repo, project.tasks, this.registry, this.opts.deps);
    sync.onResult((r) => {
      for (const taskId of unpushed) {
        project.tasks.recordEvent(taskId, r.ok ? `pushed to ${sync.status().remote} (${r.commit!.slice(0, 8)})` : `push to ${sync.status().remote} failed: ${r.error}`);
      }
      if (r.ok) unpushed.clear();
    });
    this.projects.set(id, project);
    if (saved) {
      project.tasks.restore(saved.tasks);
      project.plans.restore(saved.plans);
    }
    log.info(`project ${id}: ${dir}${store ? ` (state in ${store.dir})` : ""}`);
    return project;
  }
}
