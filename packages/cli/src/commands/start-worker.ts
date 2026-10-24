import { createLogger, hubHttpBase, resolveWorkerToken } from "@aso/shared";
import { checkTransport, joinHub } from "../join.js";
import { startWorker, type WorkerHandle } from "@aso/worker";
import { layout } from "../layout.js";
import { runsAsSystemdService } from "../service.js";
import { installHubPackage } from "./update.js";

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
  join?: string;
  allowInsecure?: boolean;
}): Promise<void> {
  await checkTransport(opts.hub, opts.port, opts.allowInsecure ?? false);
  if (opts.join) await joinHub(opts.hub, opts.port, opts.join);
  const token = opts.token ?? resolveWorkerToken()?.token;
  if (!token) {
    throw new Error("no worker key: join with --join <code> (from `aso worker-key new` on the Hub), or pass --token");
  }
  const { sandboxImage, sandboxNetwork, join: _join, allowInsecure: _allowInsecure, ...rest } = opts;
  // Our unit has Restart=always, so exiting restarts the worker on the installed build.
  const supervisor = runsAsSystemdService(process.env, process.pid) ? ("systemd" as const) : undefined;
  // Only a package install run as a service updates itself: a source checkout follows its git
  // remote, not the Hub, and nothing would start a hand-started worker again.
  const canUpdateItself = supervisor !== undefined && layout.mode === "package";
  const update = async () => {
    const installed = await installHubPackage(hubHttpBase(opts.hub, opts.port));
    // Restart even when nothing was installed: re-registering settles what the Hub thinks this build is.
    shutdown(installed ? "updated" : "update requested, already on the Hub's build");
  };
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
    onUpdate: canUpdateItself ? update : undefined,
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
