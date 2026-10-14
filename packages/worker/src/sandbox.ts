import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@aso/shared";
import { runCommand, type CommandResult } from "./run-command.js";

const log = createLogger("sandbox");
const exec = promisify(execFile);

export interface RunOptions {
  /** The task checkout, or a directory inside it. */
  cwd: string;
  timeoutMs: number;
  /** Extra variables for the command. Only these reach a sandboxed command; nothing of the worker's own environment does. */
  env?: Record<string, string>;
}

/** Runs the commands of a job: agent `run_command`, `npm ci`, QA setup and tests. */
export interface CommandRunner {
  readonly kind: "docker" | "host";
  /** Rejects only when the command could not be started at all (missing program, Docker error). */
  run(argv: readonly string[], opts: RunOptions): Promise<CommandResult>;
}

/** No isolation: commands run directly on this machine, as the worker's user, with its environment. */
export const hostRunner: CommandRunner = {
  kind: "host",
  run: (argv, opts) => runCommand(argv, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, env: { ...process.env, ...opts.env } }),
};

/** Pinned so the system libraries match what Playwright's browsers expect. */
const PLAYWRIGHT_VERSION = "1.64.1";

/**
 * The job image: Node (same major as the worker) plus the system libraries headless Chromium
 * needs, so e2e tests can run. Browsers themselves are downloaded into the shared cache.
 */
export function sandboxDockerfile(nodeMajor: string): string {
  return [
    `FROM node:${nodeMajor}-bookworm`,
    `RUN npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium && rm -rf /var/lib/apt/lists/* /root/.npm`,
    "",
  ].join("\n");
}

export function defaultSandboxImage(nodeMajor = process.versions.node.split(".")[0]): { tag: string; dockerfile: string } {
  const dockerfile = sandboxDockerfile(nodeMajor);
  const hash = createHash("sha256").update(dockerfile).digest("hex").slice(0, 12);
  return { tag: `aso-sandbox:node${nodeMajor}-${hash}`, dockerfile };
}

export interface DockerSandboxOptions {
  /** The worker's work directory; checkouts live below it. */
  workDir: string;
  /** Image to run commands in. Default: built from `sandboxDockerfile` on first use. */
  image?: string;
  /** Shared npm and Playwright browser cache, mounted into every container. Default: `<workDir>/../cache`. */
  cacheDir?: string;
  /** `docker run --network`. Default `bridge` (internet access, for npm and browser downloads). */
  network?: string;
  /** Host user the commands run as, so files in the checkout keep their owner. Default: the worker's. */
  user?: string;
}

/**
 * Runs every command in its own throwaway container that can see only the task checkout.
 * The container has no capabilities, cannot gain privileges, has a read-only root filesystem,
 * gets none of the worker's environment (so no ASO token), and sees `.git` read-only so it
 * cannot plant hooks or config that the worker's own git would run on the host.
 */
export class DockerSandbox implements CommandRunner {
  readonly kind = "docker";
  readonly image: string;
  private readonly build?: string;
  private readonly cacheDir: string;
  private readonly network: string;
  private readonly user: string;
  private readonly label: string;

  constructor(private readonly opts: DockerSandboxOptions) {
    const fallback = defaultSandboxImage();
    this.image = opts.image ?? fallback.tag;
    this.build = opts.image ? undefined : fallback.dockerfile;
    this.cacheDir = path.resolve(opts.cacheDir ?? path.join(opts.workDir, "..", "cache"));
    this.network = opts.network ?? "bridge";
    this.user = opts.user ?? `${os.userInfo().uid}:${os.userInfo().gid}`;
    // Scopes cleanup to this work directory, so two workers on one machine leave each other alone.
    this.label = `aso.sandbox=${createHash("sha256").update(path.resolve(opts.workDir)).digest("hex").slice(0, 16)}`;
  }

  /** Check Docker, build or pull the image, and remove containers a previous run left behind. */
  async prepare(): Promise<void> {
    try {
      await exec("docker", ["version", "--format", "{{.Server.Version}}"]);
    } catch (err) {
      throw new Error(
        `Docker is not usable by this user (${firstLine(err)}). Install Docker and add the user to the docker group, ` +
          "or start the worker with --sandbox none to run agent commands directly on this machine",
      );
    }
    await mkdir(path.join(this.cacheDir, "npm"), { recursive: true });
    await mkdir(path.join(this.cacheDir, "ms-playwright"), { recursive: true });

    const present = await exec("docker", ["image", "inspect", this.image]).then(() => true, () => false);
    if (!present) {
      if (this.build) {
        log.info(`building sandbox image ${this.image} (first run only; takes a few minutes)`);
        await dockerBuild(this.image, this.build);
      } else {
        log.info(`pulling sandbox image ${this.image}`);
        await exec("docker", ["pull", this.image], { maxBuffer: 16 * 1024 * 1024 });
      }
    }
    const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `label=${this.label}`]);
    const stale = stdout.split("\n").filter(Boolean);
    if (stale.length) {
      log.info(`removing ${stale.length} sandbox container(s) left from an earlier run`);
      await exec("docker", ["rm", "-f", ...stale]).catch(() => undefined);
    }
    log.info(`agent commands run in Docker (${this.image}, network ${this.network})`);
  }

  async run(argv: readonly string[], opts: RunOptions): Promise<CommandResult> {
    const name = `aso-job-${randomUUID().slice(0, 12)}`;
    const args = dockerRunArgs({
      name,
      label: this.label,
      image: this.image,
      user: this.user,
      network: this.network,
      checkout: checkoutRoot(opts.cwd, this.opts.workDir),
      cwd: opts.cwd,
      cacheDir: this.cacheDir,
      env: opts.env ?? {},
      argv,
    });
    const result = await runCommand(["docker", ...args], { cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    // Killing the docker client does not stop the container; remove it explicitly.
    if (result.timedOut) await exec("docker", ["rm", "-f", name]).catch(() => undefined);
    else if (result.exitCode === 125) throw new Error(`docker could not run the command: ${result.output.trim().split("\n").slice(-3).join(" ")}`);
    else if (result.exitCode === 127 && /OCI runtime|executable file not found|\[FATAL tini \(\d+\)\] exec /.test(result.output)) {
      throw new Error(`${argv[0]} is not installed in the sandbox image (${this.image})`);
    }
    return result;
  }
}

export interface DockerRunSpec {
  name: string;
  label: string;
  image: string;
  user: string;
  network: string;
  /** Host path of the task checkout; mounted at the same path. */
  checkout: string;
  cwd: string;
  cacheDir: string;
  env: Record<string, string>;
  argv: readonly string[];
}

/** The `docker run` arguments for one sandboxed command (pure, so the policy is testable). */
export function dockerRunArgs(spec: DockerRunSpec): string[] {
  const env: Record<string, string> = {
    HOME: "/tmp",
    CI: "1",
    npm_config_cache: "/cache/npm",
    npm_config_update_notifier: "false",
    PLAYWRIGHT_BROWSERS_PATH: "/cache/ms-playwright",
    NEXT_TELEMETRY_DISABLED: "1",
    ...spec.env,
  };
  return [
    "run",
    "--rm",
    "--name", spec.name,
    "--label", spec.label,
    "--init",
    "--user", spec.user,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", "4096",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,size=4g",
    "--shm-size", "1g",
    "--network", spec.network,
    // Same path inside and out, so absolute paths in caches and error messages stay valid.
    "--volume", `${spec.checkout}:${spec.checkout}`,
    "--volume", `${path.join(spec.checkout, ".git")}:${path.join(spec.checkout, ".git")}:ro`,
    "--volume", `${spec.cacheDir}:/cache`,
    "--workdir", spec.cwd,
    ...Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    // The program itself is the entrypoint: images like node's wrap commands in a shell script
    // that runs unknown names as `node <name>`.
    "--entrypoint", spec.argv[0],
    spec.image,
    ...spec.argv.slice(1),
  ];
}

/** The checkout directory (`<workDir>/<name>`) that contains `cwd`; refuses anything else. */
function checkoutRoot(cwd: string, workDir: string): string {
  const rel = path.relative(path.resolve(workDir), path.resolve(cwd));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${cwd} is not inside the work directory ${workDir}`);
  return path.join(path.resolve(workDir), rel.split(path.sep)[0]);
}

function dockerBuild(tag: string, dockerfile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["build", "--tag", tag, "-"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr = (stderr + c.toString()).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`building the sandbox image failed:\n${stderr.trim().split("\n").slice(-10).join("\n")}`)),
    );
    child.stdin.end(dockerfile);
  });
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e.stderr || e.message || String(err)).trim().split("\n")[0];
}
