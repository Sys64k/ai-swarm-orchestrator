import os from "node:os";
import path from "node:path";

/** systemd user unit name of the worker service. */
export const WORKER_SERVICE = "aso-worker.service";

/** The `start-worker` options a service can carry: keep in step with `workerOptions` in index.ts and `workerArgs` below. */
export interface WorkerServiceOptions {
  hub: string;
  port?: number;
  workDir?: string;
  sandbox?: "docker" | "none";
  sandboxImage?: string;
  sandboxNetwork?: string;
}

/** `start-worker` arguments for the service, with defaults left out so later defaults apply. */
export function workerArgs(o: WorkerServiceOptions, defaultPort: number): string[] {
  const args = ["start-worker", "--hub", o.hub];
  if (o.port !== undefined && o.port !== defaultPort) args.push("--port", String(o.port));
  if (o.workDir) args.push("--work-dir", path.resolve(o.workDir));
  if (o.sandbox && o.sandbox !== "docker") args.push("--sandbox", o.sandbox);
  if (o.sandboxImage) args.push("--sandbox-image", o.sandboxImage);
  if (o.sandboxNetwork) args.push("--sandbox-network", o.sandboxNetwork);
  return args;
}

/** One ExecStart word for systemd: `%` and `$` escaped, double-quoted when it isn't a plain word. */
export function systemdQuote(word: string): string {
  // "$$$$" in a JS replacement string yields "$$", systemd's escape for a literal "$".
  const escaped = word.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(escaped) ? escaped : `"${escaped.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An `Environment=` assignment (no `$` expansion there, only `%` specifiers). */
function environment(name: string, value: string): string {
  const escaped = `${name}=${value}`.replace(/%/g, "%%").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `Environment="${escaped}"`;
}

/**
 * The worker's systemd user unit. It runs the same `aso` this command ran from (so `aso update`
 * plus a restart moves it to the new version), restarts on failure, and keeps the PATH it was
 * installed with so it finds docker and git like the person's shell does.
 */
export function workerUnit(opts: { node: string; script: string; args: string[]; path: string; envFile?: string; hub: string }): string {
  const exec = [opts.node, opts.script, ...opts.args].map(systemdQuote).join(" ");
  return `# Installed by \`aso service install\`; remove with \`aso service uninstall\`.
[Unit]
Description=ASO worker (Hub ${opts.hub})
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=always
RestartSec=10
${environment("PATH", opts.path)}
${opts.envFile ? `EnvironmentFile=${systemdQuote(opts.envFile)}\n` : ""}
[Install]
WantedBy=default.target
`;
}

/**
 * Whether systemd runs this process as a service's main process (it then starts it again after
 * it exits, so a restart from the console is safe). A shell inside a desktop's systemd unit
 * inherits SYSTEMD_EXEC_PID too, but with another pid, so a hand-started worker never matches.
 */
export function runsAsSystemdService(env: NodeJS.ProcessEnv, pid: number): boolean {
  return env.SYSTEMD_EXEC_PID === String(pid);
}

/** Whether a `.env` file the CLI loads on start already sets this token (then the service finds it too). */
export function envFilesSetToken(contents: readonly string[], token: string): boolean {
  return contents.some((text) =>
    text.split(/\r?\n/).some((line) => {
      const m = /^\s*(?:export\s+)?ASO_TOKEN\s*=\s*(.*)$/.exec(line);
      return !!m && m[1].trim().replace(/^(["'])(.*)\1$/, "$2") === token;
    }),
  );
}

/**
 * Whether the service needs its own token file: not when the worker finds the token by itself,
 * in the token file or in a `.env` file the CLI loads on start.
 */
export function needsTokenEnvFile(token: { token: string; source: string }, tokenFilePath: string, envContents: readonly string[]): boolean {
  return token.source !== tokenFilePath && !envFilesSetToken(envContents, token.token);
}

export function userUnitDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user");
}
