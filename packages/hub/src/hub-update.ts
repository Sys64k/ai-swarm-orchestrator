import type { HubUpdate } from "@aso/shared";
import type { PushNotification } from "./push/changes.js";

/**
 * The notification for a new state of the Hub's own update: only when it ends, updated or failed,
 * and once per outcome (the updater may report the same state again).
 */
export function hubUpdateNotification(previous: HubUpdate, next: HubUpdate): PushNotification | undefined {
  const same = previous.state === next.state && previous.target === next.target && previous.current === next.current;
  if (same) return undefined;
  const base = { url: "/", tag: "hub-update" };
  if (next.state === "updated") return { ...base, title: "Hub updated", body: `Now running ${next.current}.` };
  if (next.state === "failed") {
    const what = next.target ? `Update to ${next.target.slice(0, 7)}` : "The update";
    return { ...base, title: "Hub update failed", body: `${what} failed: ${next.error ?? "no reason given"}. Still running ${next.current}.` };
  }
  return undefined;
}
