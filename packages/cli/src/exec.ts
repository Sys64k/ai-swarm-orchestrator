import { spawn } from "node:child_process";

/** Runs a command and resolves with its stdout; rejects with the end of its output. */
export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<string>;

/**
 * Run a command; resolve with stdout, reject naming how it ended and its last lines of output.
 * `env` replaces the environment when given (the default is this process's).
 */
export const execCommand: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let tail = "";
    const keep = (chunk: Buffer) => (tail = (tail + chunk.toString("utf8")).slice(-4000));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      keep(chunk);
    });
    child.stderr.on("data", keep);
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const last = tail.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");
      reject(new Error(`\`${cmd} ${args[0]}\` ${code === null ? `stopped by ${signal}` : `exited with code ${code}`}${last ? `: ${last}` : ""}`));
    });
  });
