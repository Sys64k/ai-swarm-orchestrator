import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger, PushSubscriptionSchema, type PushSubscriptionJson } from "@aso/shared";
import { notableChanges, type ProjectState, type PushNotification } from "./changes.js";
import { generateVapidKeys, sendPush, type PushResult, type VapidKeys } from "./web-push.js";

const log = createLogger("push");

interface StoredSubscription extends PushSubscriptionJson {
  createdAt: string;
}

interface PushFile {
  vapid: VapidKeys;
  subscriptions: StoredSubscription[];
}

/** VAPID contact used when none is configured: where push services can learn what sends these. */
const DEFAULT_SUBJECT = "https://github.com/vaisajuh/ai-swarm-orchestrator";

/** The message "Send a test" delivers. */
export const TEST_NOTIFICATION: PushNotification = {
  title: "ASO notifications work",
  body: "You'll hear about plans to approve, failed tasks and finished plans.",
  url: "/",
  tag: "test",
};

/** Devices one Hub notifies at most; the oldest is dropped beyond this. */
const MAX_SUBSCRIPTIONS = 50;

export interface NotifierOptions {
  /** Folder for `push.json` (keys and subscriptions). Undefined keeps them in memory. */
  dir?: string;
  /** VAPID contact (mailto: or https:) push services may use to reach the Hub's operator. */
  subject?: string;
  /** Replaces the real delivery (tests). */
  send?: typeof sendPush;
}

/**
 * Sends Web Push notifications to every device that turned them on in the console. The key pair
 * and subscriptions are Hub-wide and survive restarts; a subscription the push service reports
 * gone (uninstalled app, revoked permission) is dropped.
 */
export class Notifier {
  private saving: Promise<unknown> = Promise.resolve();
  private readonly seen = new Map<string, string>();

  private constructor(
    private readonly data: PushFile,
    private readonly opts: NotifierOptions,
  ) {}

  static async open(opts: NotifierOptions = {}): Promise<Notifier> {
    const file = opts.dir && path.join(opts.dir, "push.json");
    let data: PushFile | undefined;
    if (file) {
      try {
        data = parsePushFile(JSON.parse(await readFile(file, "utf8")));
        if (!data) throw new Error("unrecognised content");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          const aside = `${file}.bad-${Date.now()}`;
          log.warn(`could not read ${file} (${(err as Error).message}); moved it to ${aside} and starting over: devices must turn notifications on again`);
          await rename(file, aside).catch(() => undefined);
        }
        data = undefined;
      }
    }
    const notifier = new Notifier(data ?? { vapid: generateVapidKeys(), subscriptions: [] }, opts);
    if (file && !data) await notifier.save();
    return notifier;
  }

  /** The key browsers subscribe with (`applicationServerKey`). */
  get publicKey(): string {
    return this.data.vapid.publicKey;
  }

  get subscriptionCount(): number {
    return this.data.subscriptions.length;
  }

  has(endpoint: string): boolean {
    return this.data.subscriptions.some((s) => s.endpoint === endpoint);
  }

  /** Add (or refresh) a device. */
  async subscribe(subscription: PushSubscriptionJson): Promise<void> {
    const sub = { endpoint: subscription.endpoint, keys: subscription.keys, createdAt: new Date().toISOString() };
    const rest = this.data.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    this.data.subscriptions = [...rest, sub].slice(-MAX_SUBSCRIPTIONS);
    await this.save();
  }

  /** Forget a device. False when it wasn't subscribed. */
  async unsubscribe(endpoint: string): Promise<boolean> {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.data.subscriptions.length === before) return false;
    await this.save();
    return true;
  }

  /** Notify about whatever changed in `project` since the last look (see `notableChanges`). */
  observe(project: ProjectState): void {
    for (const n of notableChanges(this.seen, project)) void this.send(n);
  }

  /** Send to every device, or only to `endpoint`. Resolves once all deliveries are done. */
  async send(n: PushNotification, endpoint?: string): Promise<{ sent: number; failed: string[] }> {
    const targets = this.data.subscriptions.filter((s) => endpoint === undefined || s.endpoint === endpoint);
    const deliver = this.opts.send ?? sendPush;
    const subject = this.opts.subject ?? DEFAULT_SUBJECT;
    const results: PushResult[] = await Promise.all(targets.map((s) => deliver(s, n, this.data.vapid, { subject })));
    const failed: string[] = [];
    const gone = new Set<string>();
    results.forEach((r, i) => {
      if (r.ok) return;
      failed.push(r.error);
      if (r.gone) gone.add(targets[i].endpoint);
      log.warn(`notification "${n.title}" to ${new URL(targets[i].endpoint).host} failed: ${r.error}${r.gone ? " (device unsubscribed; removed)" : ""}`);
    });
    if (gone.size) {
      this.data.subscriptions = this.data.subscriptions.filter((s) => !gone.has(s.endpoint));
      await this.save();
    }
    return { sent: results.filter((r) => r.ok).length, failed };
  }

  /** Writes are serialised and atomic; the file holds the private key, so only the owner can read it. */
  private save(): Promise<unknown> {
    const dir = this.opts.dir;
    if (!dir) return Promise.resolve();
    const file = path.join(dir, "push.json");
    const json = JSON.stringify(this.data, null, 2);
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(`${file}.tmp`, json, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      } catch (err) {
        log.warn(`could not save ${file}: ${(err as Error).message}`);
      }
    });
    return this.saving;
  }
}

function parsePushFile(raw: unknown): PushFile | undefined {
  const f = raw as Partial<PushFile> | null;
  if (!f || typeof f.vapid?.publicKey !== "string" || typeof f.vapid.privateKey !== "object" || !Array.isArray(f.subscriptions)) return undefined;
  const subscriptions = f.subscriptions.filter((s): s is StoredSubscription => PushSubscriptionSchema.safeParse(s).success);
  return { vapid: f.vapid, subscriptions };
}
