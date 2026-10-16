import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger, hubHttpBase } from "@aso/shared";
import { layout } from "../layout.js";
import { restartWorkerService, workerServiceActive } from "../systemd.js";

const log = createLogger("cli");

/**
 * Run a command with its output shown (in a service: the journal). Async, so a worker keeps its
 * heartbeats meanwhile. A failure names the command's own error line, which the console shows.
 */
function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  log.info(`$ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-8192);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve();
      const detail = errorLine(stderr);
      reject(new Error(`${cmd} ${args[0]} exited with code ${code}${detail ? `: ${detail}` : ""}`));
    });
  });
}

/** The line of a failed command's stderr that says what went wrong: npm's own message, else the last line. */
export function errorLine(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const npm = lines.filter((l) => /^npm (error|ERR!)/.test(l) && !/^npm (error|ERR!) (code \S+$|errno |A complete log)/.test(l));
  const line = npm[0]?.replace(/^npm (error|ERR!)\s*/, "") ?? lines.at(-1);
  return line?.slice(0, 500);
}

/**
 * Update this machine's aso.
 * - package install: download the package the Hub serves (if its version differs) and install it
 * - source checkout: git pull, npm ci, rebuild
 * - --spec: install exactly that npm spec
 */
export async function updateCommand(opts: { hub: string; spec?: string }): Promise<void> {
  if (opts.spec) {
    await run("npm", ["install", "--global", opts.spec]);
    afterUpdate();
    return;
  }
  if (layout.mode === "source") {
    const root = layout.sourceRoot!;
    log.info(`source checkout at ${root} (version ${layout.version()}): pulling and rebuilding`);
    await run("git", ["pull", "--ff-only"], root);
    await run("npm", ["ci"], root);
    await run("npm", ["run", "build"], root);
    afterUpdate();
    return;
  }
  if (await installHubPackage(hubHttpBase(opts.hub))) afterUpdate();
}

/**
 * Install the package the Hub at `base` serves, unless this build already is it. Returns
 * whether it installed one. The worker calls this when the Hub asks it to update.
 */
export async function installHubPackage(base: string, current = layout.version()): Promise<boolean> {
  const res = await fetch(`${base}/api/version`).catch(() => {
    throw new Error(`cannot reach the Hub at ${base} (use --hub or set ASO_HUB)`);
  });
  const info = (await res.json()) as { version: string | null; package: boolean; sha256: string | null };
  if (!info.package || !info.sha256) throw new Error(`the Hub at ${base} has no aso package to serve`);
  if (info.version === current) {
    log.info(`already up to date (${current})`);
    return false;
  }
  log.info(`updating ${current} -> ${info.version} from ${base}`);

  // npm refuses remote tarball URLs by default; download, verify against the Hub's checksum,
  // and install the local file (no registry access needed).
  const dl = await fetch(`${base}/dist/aso.tgz`);
  if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status}`);
  const data = Buffer.from(await dl.arrayBuffer());
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== info.sha256) throw new Error("downloaded package does not match the Hub's checksum; not installing");
  const dir = await mkdtemp(path.join(os.tmpdir(), "aso-update-"));
  try {
    const file = path.join(dir, "aso.tgz");
    await writeFile(file, data);
    await run("npm", ["install", "--global", "--no-audit", "--no-fund", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return true;
}

/** The worker service runs the new version only after a restart; do it rather than tell people to. */
function afterUpdate(): void {
  if (workerServiceActive()) restartWorkerService();
  else log.info("updated; restart running aso processes to use the new version");
}
