#!/usr/bin/env node
/**
 * Builds the distributable `aso` package:
 *   release/aso-cli-<version>.tgz  (and release/aso.tgz, which the Hub serves)
 * Contents: dist/aso.mjs (CLI + all JS dependencies, bundled), dashboard.tar.gz (Next.js
 * standalone server, extracted on first use), docker/ (Hub image for `start-hub --docker`).
 * Installing needs no registry access: npm install -g ./release/aso.tgz
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, "release", "stage");
const sh = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();

const cliPkg = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8"));
/** Build id: commit (+ -dirty), or ASO_BUILD where there is no .git (Docker builds). */
function buildId() {
  if (process.env.ASO_BUILD) return process.env.ASO_BUILD;
  try {
    const dirty = out("git", ["status", "--porcelain"]) ? "-dirty" : "";
    return `${out("git", ["rev-parse", "--short", "HEAD"])}${dirty}`;
  } catch {
    return "unknown";
  }
}
const asoBuild = buildId();
const version = `${cliPkg.version}+${asoBuild}`;

console.log(`building aso ${version}`);
if (!process.argv.includes("--skip-build")) {
  sh("npm", ["run", "build"]);
  sh("npm", ["run", "build:dashboard"]);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, "dist"), { recursive: true });

await build({
  entryPoints: [path.join(root, "packages/cli/dist/index.js")],
  outfile: path.join(stage, "dist/aso.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Optional native accelerators of `ws` / platform-specific helpers: loaded in try/catch at runtime.
  external: ["bufferutil", "utf-8-validate", "osx-temperature-sensor"],
  // CommonJS dependencies inside an ES module bundle need require/__dirname.
  banner: {
    js: [
      'import { createRequire as __asoCreateRequire } from "node:module";',
      'import { fileURLToPath as __asoFileURLToPath } from "node:url";',
      'import { dirname as __asoDirname } from "node:path";',
      "const require = __asoCreateRequire(import.meta.url);",
      "const __filename = __asoFileURLToPath(import.meta.url);",
      "const __dirname = __asoDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "warning",
});

// Dashboard: standalone server incl. its node_modules, as an inner archive (npm pack drops node_modules).
sh("tar", ["-czf", path.join(stage, "dashboard.tar.gz"), "-C", path.join(root, "packages/dashboard/.next/standalone"), "."]);

// Docker: the image runs this same package.
mkdirSync(path.join(stage, "docker"));
writeFileSync(
  path.join(stage, "docker/Dockerfile"),
  `# ASO Hub image built from the installed aso package (context: the package root).
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/* \\
  && git config --system safe.directory '*' \\
  && mkdir -p /data && chmod 1777 /data
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOME=/data
COPY . /opt/aso
ENTRYPOINT ["node", "/opt/aso/dist/aso.mjs"]
# The host-side aso start-hub --docker answers LAN discovery: broadcasts never reach this container.
CMD ["start-hub", "--root", "/projects", "--no-architect", "--no-discovery"]
`,
);
const composeSource = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
if (!composeSource.includes("      context: .\n")) throw new Error("docker-compose.yml build context not found; update scripts/package.mjs");
const compose = composeSource
  .replace("      context: .\n", "      context: ..\n      dockerfile: docker/Dockerfile\n")
  .replace("image: aso-hub:local", "image: aso-hub:pkg");
writeFileSync(path.join(stage, "docker/docker-compose.yml"), compose);
cpSync(path.join(root, ".env.example"), path.join(stage, ".env.example"));
if (existsSync(path.join(root, "README.md"))) cpSync(path.join(root, "README.md"), path.join(stage, "README.md"));
cpSync(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));

writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: "aso-cli",
      version: cliPkg.version,
      asoBuild,
      description: "AI Swarm Orchestrator: Hub, worker and Architect in one CLI",
      license: "MIT",
      type: "module",
      bin: { aso: "dist/aso.mjs" },
      engines: { node: ">=20" },
      files: ["dist", "dashboard.tar.gz", "docker", ".env.example", "README.md", "LICENSE"],
    },
    null,
    2,
  ) + "\n",
);

const tgz = out("npm", ["pack", "--silent", "--pack-destination", path.join(root, "release")].concat([stage])).split("\n").pop();
copyFileSync(path.join(root, "release", tgz), path.join(root, "release", "aso.tgz"));
// What the Hub advertises for the package it serves (compared by `aso update`).
writeFileSync(path.join(root, "release", "aso.json"), JSON.stringify({ version }) + "\n");
rmSync(stage, { recursive: true, force: true });
console.log(`release/${tgz} (also release/aso.tgz)`);
