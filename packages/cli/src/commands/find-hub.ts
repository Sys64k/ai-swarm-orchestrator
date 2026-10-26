import { resolveWorkerToken } from "@aso/shared";
import { findHub } from "../join.js";

/** `aso find-hub`: ask the LAN and the tailnet where the Hub is, with this machine's worker key (or `--join` code). */
export async function findHubCommand(opts: { join?: string }): Promise<void> {
  const credential = opts.join ?? resolveWorkerToken()?.token;
  if (!credential) throw new Error("no worker key on this machine: pass --join <code> (from `aso worker-key new` on the Hub)");
  const found = await findHub(credential);
  console.log(found.address);
  console.error(found.via === "tailnet" ? "(it answered over Tailscale)" : "(it answered on this LAN)");
}
