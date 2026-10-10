import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Tail of combined stdout/stderr. */
  output: string;
  durationMs: number;
}

const OUTPUT_TAIL_CHARS = 200_000;

/**
 * Run an argv without a shell. The child gets its own process group so a timeout kills the
 * whole tree (npm → vitest → workers), not just the top process. Rejects only if the program
 * cannot be started (e.g. ENOENT).
 */
export function runCommand(
  argv: readonly string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_TAIL_CHARS * 2) output = output.slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      killTree(); // reap stragglers that outlived the parent
      resolve({
        exitCode,
        signal,
        timedOut,
        output: output.slice(-OUTPUT_TAIL_CHARS),
        durationMs: Date.now() - started,
      });
    });
  });
}
