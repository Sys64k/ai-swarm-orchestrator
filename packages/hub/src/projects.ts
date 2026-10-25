import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger, gitBasicAuthConfig, ProjectIdSchema, type LlmUsage } from "@aso/shared";
import { DependencyManager, type DependencyManagerOptions } from "./dependencies.js";
import { GitHubApi, GitHubError, parseGitHubRepo, type RepoSlug } from "./git/github.js";
import { HubRepository } from "./git/hub-repo.js";
import { PullRequests, type PullRequestOptions, type PullRequestStatus } from "./git/pull-requests.js";
import { GitSync } from "./git/sync.js";
import { PlanManager, type PlanRecord } from "./plans.js";
import type { NodeRegistry } from "./registry.js";
import { StateStore } from "./state-store.js";
import { TaskManager, type AgentTurn, type TaskManagerOptions, type TaskRecord } from "./tasks.js";
import { Transcripts, type TranscriptInput, type TranscriptSubject } from "./transcripts.js";
import { Screenshots } from "./screenshots.js";

const log = createLogger("projects");

/** How often a project's main catches up with its remote's, for merges made outside ASO. */
export const FOLLOW_MS = 2 * 60_000;
/** How long planning or approving waits for that catch-up before going ahead with main as it is. */
export const FOLLOW_WAIT_MS = 15_000;

interface FollowState {
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
  error?: string;
}

/** Wait for `promise`, but no longer than `ms` (it keeps running). */
async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
const exec = promisify(execFile);

async function initRepo(dir: string, branch: string): Promise<void> {
  await exec("git", ["init", "--quiet", `--initial-branch=${branch}`], { cwd: dir });
  await exec("git", ["-c", "user.name=ASO Hub", "-c", "user.email=aso-hub@localhost", "commit", "--quiet", "--allow-empty", "-m", "Initial commit"], { cwd: dir });
}

/** Everything the Hub keeps for one project; each project's state lives in its own `.git/aso/`. */
export interface Project {
  id: string;
  dir: string;
  repo: HubRepository;
  tasks: TaskManager;
  plans: PlanManager;
  deps: DependencyManager;
  sync: GitSync;
  /** Whether QA-approved work goes to GitHub pull requests, and if not, why. */
  pullRequests: PullRequestStatus;
  transcripts: Transcripts;
  /** The screenshots of each task's last passing QA run. */
  screenshots: Screenshots;
  store?: StateStore;
}

export class ProjectError extends Error {
  constructor(
    message: string,
    /** upstream: GitHub failed. */
    readonly code: "not_found" | "conflict" | "invalid" | "upstream",
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
  /** GitHub pull requests for QA-approved work (the token defaults to `sync.token`). */
  pullRequests?: Omit<PullRequestOptions, "token"> & {
    token?: string;
    /** The Git URL of a GitHub repository (tests point it at a local one). Default: its https://github.com URL. */
    gitUrl?: (slug: RepoSlug) => string;
  };
  /** Called after any task or plan of a project changed (notifications). */
  onChange?: (project: Project) => void;
  /** Called after a task was merged into a project's main, or main caught up with the remote's (deploys). */
  onMerged?: (project: Project) => void;
  /** How often each pushing project's main catches up with its remote's. Default FOLLOW_MS; 0: only before planning and approving. */
  followMs?: number;
}

/**
 * The Hub's projects. They share the workers and the Architect: dispatching is Hub-wide, task and
 * plan ids are unique across projects, and lookups by id find the owning project.
 */
export class ProjectSet {
  private readonly projects = new Map<string, Project>();
  private readonly reviewers = new Map<string, PullRequests>();
  /** Per project: its catch-up timer, the catch-up in progress (shared by everyone who asks meanwhile), and why the last one failed. */
  private readonly follows = new Map<string, FollowState>();
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

  /**
   * Create `<root>/<name>` and open it: a new git repository with an empty first commit, or,
   * with `github`, connected to that GitHub repository. An empty repository gets the first
   * commit pushed; one with code is cloned. Either way pull requests work from the start.
   */
  async create(name: unknown, opts: { github?: string } = {}): Promise<Project> {
    if (!this.opts.root) throw new ProjectError("this Hub has no projects root, so it cannot create projects", "invalid");
    const parsed = ProjectIdSchema.safeParse(name);
    if (!parsed.success) throw new ProjectError(parsed.error.issues[0].message, "invalid");
    const id = parsed.data;
    const dir = path.join(this.opts.root, id);
    if (this.projects.has(id) || existsSync(dir)) throw new ProjectError(`${id} already exists in ${this.opts.root}`, "conflict");
    const branch = this.opts.mainBranch ?? "main";
    const github = opts.github === undefined ? undefined : await this.githubRepo(opts.github, branch);

    await mkdir(dir);
    try {
      if (github) await this.connectGitHub(dir, github, branch);
      else await initRepo(dir, branch);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }); // created above: nothing of anyone else's
      throw err;
    }
    log.info(`created project ${id} in ${dir}${github ? ` from GitHub ${github.slug.owner}/${github.slug.repo}` : ""}`);
    return this.add(id, dir);
  }

  /** The GitHub repository to connect, once the Hub's token is known to write to it. */
  private async githubRepo(input: string, branch: string): Promise<{ slug: RepoSlug; url: string; token: string }> {
    const slug = parseGitHubRepo(input);
    if (!slug) throw new ProjectError(`${input} is not a GitHub repository: use owner/repo or its github.com URL`, "invalid");
    const name = `${slug.owner}/${slug.repo}`;
    const token = this.opts.pullRequests?.token ?? this.opts.sync.token;
    if (!token) throw new ProjectError("connecting a GitHub repository needs the Hub's GitHub token (ASO_GIT_TOKEN)", "invalid");
    let access: { push: boolean; defaultBranch: string };
    try {
      access = await new GitHubApi(slug, token, this.opts.pullRequests?.apiUrl).repoAccess();
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 403)) {
        throw new ProjectError(`the Hub's GitHub token can't reach ${name}: create the repository on GitHub, then add it to the token's repository access`, "invalid");
      }
      throw new ProjectError(`could not check ${name} on GitHub: ${(err as Error).message}`, "upstream");
    }
    if (!access.push) throw new ProjectError(`the Hub's GitHub token can read ${name} but not write to it: give it Contents and Pull requests write access`, "invalid");
    if (access.defaultBranch !== branch) {
      throw new ProjectError(`${name}'s default branch is ${access.defaultBranch}; the Hub works on ${branch}, so make ${branch} the default branch first`, "invalid");
    }
    return { slug, url: this.opts.pullRequests?.gitUrl?.(slug) ?? `https://github.com/${slug.owner}/${slug.repo}.git`, token };
  }

  /** Clone the repository into `dir`, or start it there and push the first commit when it is empty. */
  private async connectGitHub(dir: string, github: { slug: RepoSlug; url: string; token: string }, branch: string): Promise<void> {
    const entry = gitBasicAuthConfig(github.url, github.token);
    const auth = entry ? ["-c", entry] : [];
    const git = async (args: string[], cwd = dir) => {
      try {
        return (await exec("git", [...auth, ...args], { cwd })).stdout;
      } catch (err) {
        const message = ((err as { stderr?: string }).stderr || (err as Error).message).split(github.token).join("***");
        throw new ProjectError(`git ${args[0]} with ${github.slug.owner}/${github.slug.repo} failed: ${message.trim().split("\n")[0]}`, "upstream");
      }
    };
    const heads = await git(["ls-remote", "--heads", github.url]);
    if (heads.trim()) {
      await git(["clone", "--quiet", "--branch", branch, "--origin", "origin", github.url, dir], path.dirname(dir));
      return;
    }
    await initRepo(dir, branch);
    await exec("git", ["remote", "add", "origin", github.url], { cwd: dir });
    await git(["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
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
    spentSinceReply: (planId: string): number => this.planOwner(planId)?.plans.spentSinceReply(planId) ?? 0,
    recordLlmUsage: (planId: string, usage: LlmUsage): void => this.planOwner(planId)?.plans.recordLlmUsage(planId, usage),
    recordAgentTurn: (planId: string, turn: Omit<AgentTurn, "at">): void => this.planOwner(planId)?.plans.recordAgentTurn(planId, turn),
    recordEvent: (planId: string, event: string): void => this.planOwner(planId)?.plans.recordEvent(planId, event),
  };

  /** Transcripts, routed to the project that owns the task or plan. */
  readonly transcripts = {
    append: (subject: TranscriptSubject, entry: TranscriptInput): void => this.ownerOf(subject)?.transcripts.append(subject, entry),
    read: (subject: TranscriptSubject, after?: number) => this.ownerOf(subject)?.transcripts.read(subject, after) ?? { entries: [], last: -1 },
  };

  /** Check a project's open pull requests now instead of at the next poll. */
  async checkReviews(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (project) await this.reviewers.get(projectId)?.check(project.tasks);
  }

  /**
   * Bring a project's main up to its remote's, for what was merged outside ASO (a pull request
   * merged by hand, a push to GitHub); a main that moved counts as a merge. Never throws.
   * `maxWaitMs` stops waiting, not the catch-up, so a slow remote can't hold up a request.
   */
  async follow(project: Project, maxWaitMs?: number): Promise<void> {
    if (!project.sync.status().enabled) return;
    const state = this.followState(project.id);
    state.running ??= this.catchUpOnce(project, state).finally(() => (state.running = undefined));
    await (maxWaitMs === undefined ? state.running : waitAtMost(state.running, maxWaitMs));
  }

  /** Catch up before planning or approving: the Architect reads main, and tasks branch from it. */
  followForPlanning(project: Project): Promise<void> {
    return this.follow(project, FOLLOW_WAIT_MS);
  }

  private followState(id: string): FollowState {
    let state = this.follows.get(id);
    if (!state) this.follows.set(id, (state = {}));
    return state;
  }

  private async catchUpOnce(project: Project, state: FollowState): Promise<void> {
    const before = await project.repo.mainHead().catch(() => undefined);
    const result = await project.sync.catchUp().catch((err: Error) => ({ ok: false as const, reason: err.message }));
    this.noteFollowError(project, state, result.ok ? undefined : result.reason);
    if (!result.ok) return;
    const after = await project.repo.mainHead().catch(() => undefined);
    if (after && after !== before) {
      log.info(`project ${project.id}: ${project.repo.mainBranch} caught up with ${project.sync.status().remote} @ ${after.slice(0, 8)}`);
      this.opts.onMerged?.(project);
    }
  }

  /** Log a catch-up failure when it starts or changes, and the recovery, not every pass. */
  private noteFollowError(project: Project, state: FollowState, reason: string | undefined): void {
    const remote = project.sync.status().remote;
    if (reason && reason !== state.error) log.warn(`project ${project.id}: could not catch up with ${remote}: ${reason}`);
    if (!reason && state.error) log.info(`project ${project.id}: catching up with ${remote} works again`);
    state.error = reason;
  }

  /** Write pending state and transcripts; later changes stay in memory (the Hub is stopping). */
  async close(): Promise<void> {
    for (const state of this.follows.values()) clearInterval(state.timer);
    for (const p of this.list()) {
      p.sync.stop();
      this.reviewers.get(p.id)?.stopPolling();
      await p.store?.close();
      await p.transcripts.close();
      await p.screenshots.flush();
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
    const screenshots = new Screenshots(store ? path.join(store.dir, "screenshots") : undefined);
    const sync = await GitSync.create(repo, { ...this.opts.sync, enabled: this.opts.sync.enabled ?? true });
    const { gate, status: pullRequests } = await PullRequests.create(sync, repo.mainBranch, { token: this.opts.sync.token, ...this.opts.pullRequests });
    log.info(`project ${id}: ${gate ? `QA-approved work goes to pull requests on ${pullRequests.repo}` : `merged on the Hub (${pullRequests.reason})`}`);
    // Filled in below; the managers' callbacks only run after construction.
    const project = { id, dir, repo, sync, pullRequests, transcripts, screenshots, store } as Project;
    /** The managers report changes while they are still being constructed; listeners wait for both. */
    const ready = () => project.tasks !== undefined && project.plans !== undefined;
    const persist = () => {
      store?.scheduleSave(() => ({ tasks: project.tasks.list(), plans: project.plans.list() }));
      if (ready()) this.opts.onChange?.(project);
    };
    /** Merged tasks waiting for their commits to reach the remote. */
    const unpushed = new Set<string>();

    project.tasks = new TaskManager(this.registry, repo, {
      ...this.opts.tasks,
      project: id,
      onDispatchNeeded: () => this.dispatchAll(),
      isIdTaken: (taskId) => !!this.taskOwner(taskId),
      onMerged: (task) => {
        this.opts.onMerged?.(project);
        if (!sync.status().enabled) return;
        unpushed.add(task.spec.taskId);
        void sync.requestPush();
      },
      reviewGate: gate,
      onChange: persist,
      onTranscript: (taskId, entry) => transcripts.append({ kind: "task", id: taskId }, entry),
      screenshots,
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
    if (gate) {
      this.reviewers.set(id, gate);
      gate.startPolling(project.tasks);
    }
    const followMs = this.opts.followMs ?? FOLLOW_MS;
    if (sync.status().enabled && followMs > 0) {
      const state = this.followState(id);
      state.timer = setInterval(() => void this.follow(project), followMs);
      state.timer.unref();
    }
    log.info(`project ${id}: ${dir}${store ? ` (state in ${store.dir})` : ""}`);
    return project;
  }
}
