/** What the browser offers for notifications, as the notifications page checks it. */
export interface PushEnvironment {
  /** Page served over https (or localhost): browsers only allow push there. */
  secure: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  permission: "default" | "granted" | "denied" | undefined;
  /** iPhone or iPad: push only works for the console added to the home screen. */
  ios: boolean;
  /** Opened from the home screen (display-mode standalone). */
  standalone: boolean;
}

/** The browser objects `detectPushEnvironment` reads (a subset, so tests can fake them). */
export interface PushProbe {
  isSecureContext: boolean;
  hasPushManager: boolean;
  notificationPermission: NotificationPermission | undefined;
  hasServiceWorker: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone: boolean;
}

export function detectPushEnvironment(p: PushProbe): PushEnvironment {
  return {
    secure: p.isSecureContext,
    serviceWorker: p.hasServiceWorker,
    pushManager: p.hasPushManager,
    notification: p.notificationPermission !== undefined,
    permission: p.notificationPermission,
    // iPadOS reports itself as a Mac; touch support gives it away.
    ios: /iPhone|iPad|iPod/.test(p.userAgent) || (p.platform === "MacIntel" && p.maxTouchPoints > 1),
    standalone: p.standalone,
  };
}

export type PushSetup =
  | { kind: "ready" }
  | { kind: "needs-https" }
  | { kind: "needs-install" }
  | { kind: "blocked" }
  | { kind: "unsupported" };

/** Whether this device can turn notifications on, and if not, what the person can do about it. */
export function pushSetup(env: PushEnvironment): PushSetup {
  if (!env.secure) return { kind: "needs-https" };
  if (env.ios && !env.standalone) return { kind: "needs-install" };
  if (!env.serviceWorker || !env.pushManager || !env.notification) return { kind: "unsupported" };
  if (env.permission === "denied") return { kind: "blocked" };
  return { kind: "ready" };
}

/** `applicationServerKey` for `pushManager.subscribe`, from the Hub's URL-safe base64 key. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether an existing subscription was made with `key` (a Hub that lost its keys needs a new one). */
export function sameKey(subscriptionKey: ArrayBuffer | null | undefined, key: Uint8Array): boolean {
  if (!subscriptionKey) return false;
  const a = new Uint8Array(subscriptionKey);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/** A readable reason for a failed `pushManager.subscribe` (browsers' messages are cryptic). */
export function subscribeProblem(message: string): string {
  if (/permission denied|not allowed/i.test(message)) {
    return "The browser refused to set up notifications. Private (incognito) windows can't get them: use a normal window, or the console added to the home screen.";
  }
  if (/push service/i.test(message)) return `The browser couldn't reach its push service (${message}). Check the device is online and try again.`;
  return message;
}

/** What `enablePush` needs from the browser and the Hub (injected so the flow is testable). */
export interface EnableDeps {
  requestPermission: () => Promise<NotificationPermission>;
  hubKey: () => Promise<{ ok: true; key: string } | { ok: false; error: string }>;
  pushManager: () => Promise<Pick<PushManager, "getSubscription" | "subscribe">>;
  save: (subscription: PushSubscriptionJSON) => Promise<string | undefined>;
}

/** Turn notifications on: permission, subscribe with the Hub's key (anew if it changed), register at the Hub. Returns a problem, or undefined. */
export async function enablePush(deps: EnableDeps): Promise<string | undefined> {
  if ((await deps.requestPermission()) !== "granted") return "Notifications were not allowed.";
  const key = await deps.hubKey();
  if (!key.ok) return key.error;
  const applicationServerKey = base64UrlToBytes(key.key);
  const manager = await deps.pushManager();
  let sub = await manager.getSubscription();
  // Made for a different Hub key (the Hub's state was reset): start over.
  if (sub && !sameKey(sub.options.applicationServerKey, applicationServerKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  try {
    sub ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey });
  } catch (err) {
    return subscribeProblem((err as Error).message);
  }
  return deps.save(sub.toJSON());
}
