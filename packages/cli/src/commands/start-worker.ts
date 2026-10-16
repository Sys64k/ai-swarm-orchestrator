import { createLogger, resolveToken } from "@aso/shared";
import { startWorker } from "@aso/worker";
import { layout } from "../layout.js";

const log = createLogger("cli");

export async function startWorkerCommand(opts: {
  hub: string;
  port: number;
  workDir?: string;
  token?: string;
  sandbox: "docker" | "none";
  sandboxImage?: string;
  sandboxNetwork?: string;
}): Promise<void> {
  const token = opts.token ?? resolveToken()?.token;
  if (!token) {
    throw new Error("no ASO token: pass --token or set ASO_TOKEN (run `aso token` on the Hub machine to see it)");
  }
  const { sandboxImage, sandboxNetwork, ...rest } = opts;
  const worker = await startWorker({ ...rest, token, version: layout.version(), sandboxOptions: { image: sandboxImage, network: sandboxNetwork } });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, stopping worker`);
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
