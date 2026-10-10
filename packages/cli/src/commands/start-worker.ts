import { createLogger, resolveToken, type WorkerRole } from "@aso/shared";
import { startWorker } from "@aso/worker";

const log = createLogger("cli");

export async function startWorkerCommand(opts: {
  hub: string;
  port: number;
  roles?: WorkerRole[];
  workDir?: string;
  token?: string;
}): Promise<void> {
  const token = opts.token ?? resolveToken()?.token;
  if (!token) {
    throw new Error("no ASO token: pass --token or set ASO_TOKEN (run `aso token` on the Hub machine to see it)");
  }
  const worker = await startWorker({ ...opts, token });

  const shutdown = (signal: string) => {
    log.info(`${signal} received, stopping worker`);
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
