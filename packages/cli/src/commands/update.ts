import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger, resolveHubUrl } from "@aso/shared";
import { layout } from "../layout.js";

const log = createLogger("cli");

function run(cmd: string, args: string[], cwd?: string): void {
  log.info(`$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} exited with code ${r.status}`);
}

/**
 * Update this machine's aso.
 * - package install: download the package the Hub serves (if its version differs) and install it
 * - source checkout: git pull, npm ci, rebuild
 * - --spec: install exactly that npm spec
 */
export async function updateCommand(opts: { hub: string; spec?: string }): Promise<void> {
  const current = layout.version();
  if (opts.spec) {
    run("npm", ["install", "--global", opts.spec]);
    return;
  }
  if (layout.mode === "source") {
    const root = layout.sourceRoot!;
    log.info(`source checkout at ${root} (version ${current}): pulling and rebuilding`);
    run("git", ["pull", "--ff-only"], root);
    run("npm", ["ci"], root);
    run("npm", ["run", "build"], root);
    log.info("updated; restart running aso processes to use the new version");
    return;
  }

  const url = resolveHubUrl(opts.hub);
  const base = `${url.protocol === "wss:" ? "https" : "http"}://${url.host}`;
  const res = await fetch(`${base}/api/version`).catch(() => {
    throw new Error(`cannot reach the Hub at ${base} (use --hub or set ASO_HUB)`);
  });
  const info = (await res.json()) as { version: string | null; package: boolean; sha256: string | null };
  if (!info.package || !info.sha256) throw new Error(`the Hub at ${base} has no aso package to serve`);
  if (info.version === current) {
    log.info(`already up to date (${current})`);
    return;
  }
  log.info(`updating ${current} -> ${info.version} from ${base}`);

  // npm refuses remote tarball URLs by default; download, verify against the Hub's checksum,
  // and install the local file (no registry access needed).
  const dl = await fetch(`${base}/dist/aso.tgz`);
  if (!dl.ok) throw new Error(`download failed: HTTP ${dl.status}`);
  const data = Buffer.from(await dl.arrayBuffer());
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== info.sha256) throw new Error("downloaded package does not match the Hub's checksum; not installing");
  const dir = mkdtempSync(path.join(os.tmpdir(), "aso-update-"));
  try {
    const file = path.join(dir, "aso.tgz");
    writeFileSync(file, data);
    run("npm", ["install", "--global", "--no-audit", "--no-fund", file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  log.info("updated; restart running aso processes to use the new version");
}
