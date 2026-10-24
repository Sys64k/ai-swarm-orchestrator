import { existsSync } from "node:fs";
import { mkdir, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import type { Exec } from "./exec.js";

/** The installed package's name (`npm run package`), under each version's node_modules. */
const PACKAGE = "aso-cli";

/**
 * The Hub's installed versions, each in its own folder (`versions/<version>/`), and `current`, a
 * link to the one the service runs. Installing never touches the running version; switching and
 * rolling back re-point the link in one rename, so neither can leave a half-installed Hub.
 */
export class HubVersions {
  constructor(readonly root: string) {}

  /** What the service runs: the CLI of whatever `current` points at. */
  get currentEntry(): string {
    return this.entry(path.join(this.root, "current"));
  }

  /** The version before the last switch (the service checks with it at each start whether to roll back). */
  get previousEntry(): string {
    return this.entry(path.join(this.root, "previous"));
  }

  /** The installed version built from `sha`, if any (its folder is named `<version>+<sha7>`). */
  async findBuild(sha: string): Promise<string | undefined> {
    const names = await readdir(path.join(this.root, "versions")).catch(() => [] as string[]);
    const name = names.find((n) => n.endsWith(`+${sha.slice(0, 7)}`) && existsSync(this.entry(path.join(this.root, "versions", n))));
    return name;
  }

  dirOf(version: string): string {
    return path.join(this.root, "versions", version.replace(/[^A-Za-z0-9._+-]/g, "_"));
  }

  /** The CLI of the version installed in `dir`. */
  entry(dir: string): string {
    return path.join(dir, "node_modules", PACKAGE, "dist", "aso.mjs");
  }

  installed(version: string): boolean {
    return existsSync(this.entry(this.dirOf(version)));
  }

  /** Install a package tarball as `version`, beside the others (into a temporary folder first). */
  async install(version: string, tarball: string, exec: Exec): Promise<string> {
    const dir = this.dirOf(version);
    if (this.installed(version)) return dir;
    const tmp = `${dir}.installing`;
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    // An absolute path: npm reads `dir/file.tgz` as a GitHub repository.
    await exec("npm", ["install", "--prefix", tmp, "--no-audit", "--no-fund", "--no-save", path.resolve(tarball)], { timeoutMs: 10 * 60_000 });
    if (!existsSync(this.entry(tmp))) throw new Error(`the package installed no ${path.relative(tmp, this.entry(tmp))}`);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    return dir;
  }

  /** The folder `current` points at, if any. */
  async current(): Promise<string | undefined> {
    try {
      return path.resolve(this.root, await readlink(path.join(this.root, "current")));
    } catch {
      return undefined;
    }
  }

  /** Point `current` at `dir` (a new link renamed over the old one). */
  switchTo(dir: string): Promise<void> {
    return this.link("current", dir);
  }

  /** Point `previous` at `dir`, the version to go back to. */
  setPrevious(dir: string): Promise<void> {
    return this.link("previous", dir);
  }

  private async link(name: string, dir: string): Promise<void> {
    const link = path.join(this.root, name);
    const tmp = `${link}.${process.pid}`;
    await rm(tmp, { force: true });
    await symlink(dir, tmp);
    await rename(tmp, link);
  }

  /** Remove every version but those in `keep`. */
  async prune(keep: readonly string[]): Promise<void> {
    const versions = path.join(this.root, "versions");
    const kept = new Set(keep.map((d) => path.resolve(d)));
    for (const name of await readdir(versions).catch(() => [])) {
      const dir = path.join(versions, name);
      if (!kept.has(dir)) await rm(dir, { recursive: true, force: true });
    }
  }
}
