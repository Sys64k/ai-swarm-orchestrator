import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createLogger } from "@aso/shared";

const log = createLogger("docker-cleanup");

/** Build cache younger than this is kept, so the next Hub update or deploy still builds fast. */
export const KEEP_CACHE = "24h";
/** Images of a project kept (newest first), so a deploy can go back a version or two. */
export const KEEP_PROJECT_IMAGES = 3;
/** At most one cleanup in this long. */
const MIN_INTERVAL_MS = 60 * 60_000;

export interface DockerImage {
  repository: string;
  tag: string;
  /** e.g. "2026-10-26 23:57:10 +0000 UTC" (`docker images` CreatedAt). */
  createdAt: string;
}

/**
 * Old images of the projects' own repositories (a repository named like a project, as deploys
 * tag them, e.g. `aso-ui:<commit>`): all but the newest `keep`, never one a container uses.
 * Other repositories on the machine are never touched.
 */
export function oldProjectImages(images: readonly DockerImage[], projects: ReadonlySet<string>, inUse: ReadonlySet<string>, keep = KEEP_PROJECT_IMAGES): string[] {
  const out: string[] = [];
  for (const project of projects) {
    const tagged = images
      .filter((i) => i.repository === project && i.tag !== "<none>")
      .sort((a, b) => Date.parse(b.createdAt.replace(/ [A-Z]+$/, "")) - Date.parse(a.createdAt.replace(/ [A-Z]+$/, "")));
    for (const image of tagged.slice(keep)) {
      const ref = `${image.repository}:${image.tag}`;
      if (!inUse.has(ref)) out.push(ref);
    }
  }
  return out;
}

export type Docker = (args: string[]) => Promise<string>;

const docker: Docker = (args) =>
  new Promise((resolve, reject) => execFile("docker", args, { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))));

/** The projects in the projects root: its folders that are git repositories. */
export function projectIds(root: string): Set<string> {
  try {
    return new Set(readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, ".git"))).map((d) => d.name));
  } catch {
    return new Set();
  }
}

/**
 * Keeps Docker from filling the Hub's disk: every Hub update and deploy builds images, and their
 * build cache and old versions pile up. After a confirmed update or a successful deploy, at most
 * once an hour: build cache older than a day, dangling images, and old project images.
 */
export class DockerCleanup {
  private lastRun = -Infinity;
  private running?: Promise<void>;

  constructor(
    private readonly projects: () => ReadonlySet<string>,
    private readonly run: Docker = docker,
    private readonly now: () => number = Date.now,
  ) {}

  /** Clean up unless it ran within the hour (or is running); never throws. */
  maybeRun(reason: string): Promise<void> {
    if (this.running || this.now() - this.lastRun < MIN_INTERVAL_MS) return this.running ?? Promise.resolve();
    this.lastRun = this.now();
    this.running = this.clean(reason).finally(() => (this.running = undefined));
    return this.running;
  }

  private async clean(reason: string): Promise<void> {
    try {
      await this.run(["builder", "prune", "-f", "--filter", `until=${KEEP_CACHE}`]);
      const inUse = new Set((await this.run(["ps", "-a", "--format", "{{.Image}}"])).split("\n").map((s) => s.trim()).filter(Boolean));
      const listed = (await this.run(["images", "--format", "{{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}"]))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [repository, tag, createdAt] = line.split("\t");
          return { repository, tag, createdAt };
        });
      const old = oldProjectImages(listed, this.projects(), inUse);
      if (old.length) await this.run(["rmi", ...old]).catch((err: Error) => log.debug(`some old images stay: ${err.message}`));
      await this.run(["image", "prune", "-f"]);
      log.info(`cleaned up Docker after ${reason}: build cache older than ${KEEP_CACHE}, dangling images${old.length ? `, ${old.length} old project image(s)` : ""}`);
    } catch (err) {
      log.warn(`Docker cleanup after ${reason} failed: ${(err as Error).message}`);
    }
  }
}
