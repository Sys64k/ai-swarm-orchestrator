import { createLogger, resolveToken } from "@aso/shared";
import { startWorker, type WorkerHandle } from "@aso/worker";
import { layout } from "../layout.js";
import { runsAsSystemdService } from "../service.js";

const log = createLogger("cli");

export async function startWorkerCommand(opts: {
  hub: string;
  port: number;
  workDir?: string;
  slots?: number;
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
  // Our unit has Restart=always, so exiting restarts the worker on the installed build.
  const supervisor = runsAsSystemdService(process.env, process.pid) ? ("systemd" as const) : undefined;
  // Declared before the worker exists: a restart request or signal can only arrive once it does.
  let worker: WorkerHandle | undefined;
  const shutdown = (reason: string): never => {
    log.info(`${reason}: stopping worker`);
    worker?.stop();
    process.exit(0);
  };
  worker = await startWorker({
    ...rest,
    token,
    version: layout.version(),
    sandboxOptions: { image: sandboxImage, network: sandboxNetwork },
    supervisor,
    onRestart: supervisor && (() => shutdown("restart request from the console")),
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
