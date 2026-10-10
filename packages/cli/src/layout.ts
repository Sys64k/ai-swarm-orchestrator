import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "@aso/shared";

/**
 * Where the CLI's files live. Two layouts:
 * - source: a git checkout of the ASO monorepo (this file is packages/cli/dist/layout.js)
 * - package: the installed `aso` package (bundled into <pkg>/dist/aso.mjs)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const sourceRoot =
  path.basename(pkgRoot) === "cli" && existsSync(path.join(pkgRoot, "..", "hub", "package.json"))
    ? path.resolve(pkgRoot, "..", "..")
    : undefined;

/** Per-user cache (extracted dashboard, the package a packaged Hub serves). */
function cacheDir(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "aso");
}

export const layout = {
  mode: sourceRoot ? ("source" as const) : ("package" as const),
  /** Monorepo root (source) or package root (package). */
  root: sourceRoot ?? pkgRoot,
  sourceRoot,
  packageJson: createRequire(import.meta.url)(path.join(pkgRoot, "package.json")) as {
    name: string;
    version: string;
    asoBuild?: string;
  },

  /** `.env` files in priority order (earlier wins; shell variables beat all of them). */
  envFiles(): string[] {
    return [process.env.ASO_ENV_FILE, path.join(configDir(), ".env"), sourceRoot && path.join(sourceRoot, ".env")].filter(
      (f): f is string => !!f,
    );
  },

  composeFile(): string {
    return sourceRoot ? path.join(sourceRoot, "docker-compose.yml") : path.join(pkgRoot, "docker", "docker-compose.yml");
  },

  /** Standalone Next.js server for the dashboard, if built (extracted from the package on first use). */
  dashboardServer(): string | undefined {
    if (!sourceRoot) {
      const archive = path.join(pkgRoot, "dashboard.tar.gz");
      if (!existsSync(archive)) return undefined;
      const dir = path.join(cacheDir(), `dashboard-${this.version()}`);
      const server = path.join(dir, "packages", "dashboard", "server.js");
      if (!existsSync(server)) {
        const tmp = `${dir}.tmp-${process.pid}`;
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        execFileSync("tar", ["-xzf", archive, "-C", tmp]);
        rmSync(dir, { recursive: true, force: true });
        renameSync(tmp, dir);
      }
      return server;
    }
    const f = path.join(sourceRoot, "packages", "dashboard", ".next", "standalone", "packages", "dashboard", "server.js");
    return existsSync(f) ? f : undefined;
  },

  /** Version of the package the Hub serves (may differ from this process in a source checkout). */
  distVersion(): string | undefined {
    if (!sourceRoot) return this.version();
    const f = path.join(sourceRoot, "release", "aso.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { version: string }).version : undefined;
  },

  /** The distributable package the Hub serves to other machines (built by `npm run package`). */
  distTarball(): string | undefined {
    if (sourceRoot) {
      const f = path.join(sourceRoot, "release", "aso.tgz");
      return existsSync(f) ? f : undefined;
    }
    // An installed package re-packs itself (once per version) so a packaged Hub can serve it too.
    const dir = path.join(cacheDir(), `package-${this.version()}`);
    const f = path.join(dir, "aso.tgz");
    if (!existsSync(f)) {
      mkdirSync(dir, { recursive: true });
      const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir, pkgRoot], { encoding: "utf8" })
        .trim()
        .split("\n")
        .pop()!;
      renameSync(path.join(dir, name), f);
    }
    return f;
  },

  version(): string {
    const p = this.packageJson;
    return p.asoBuild ? `${p.version}+${p.asoBuild}` : p.version;
  },
};

/** For diagnostics: the files under a directory, shallow. */
export function list(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}
