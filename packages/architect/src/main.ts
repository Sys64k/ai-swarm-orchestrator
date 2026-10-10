#!/usr/bin/env node
/**
 * Architect entrypoint, started by `aso start-hub` in a persistent tmux session on the Hub
 * machine. Plans work; never writes code.
 */
import { startArchitect } from "./client.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const architect = startArchitect({ hub: arg("--hub") ?? "127.0.0.1", workDir: arg("--work-dir") });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    architect.stop();
    process.exit(0);
  });
}
