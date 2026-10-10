import { createLogger, type WorkerRole } from "@aso/shared";
import { startWorker } from "@aso/worker";

const log = createLogger("cli");

export async function startWorkerCommand(opts: {
  hub: string;
  port: number;
  roles?: WorkerRole[];
  workDir?: string;
}): Promise<void> {
  const worker = await startWorker(opts);

  const shutdown = (signal: string) => {
    log.info(`${signal} received, stopping worker`);
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
