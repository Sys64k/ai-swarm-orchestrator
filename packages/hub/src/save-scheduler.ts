import { createLogger } from "@aso/shared";

const log = createLogger("state");

export interface SaveSchedulerOptions {
  /** What is being saved, for logs ("project shop's state"). */
  what: string;
  /** Changes arriving within this long are batched into one write. */
  delayMs?: number;
  /** After a failed write, the next try. */
  retryMs?: number;
  /** On close, how many more times a failed write is tried before its changes are given up. */
  closeRetries?: number;
}

/**
 * Batches saves of a changing state and writes them one at a time, so an older snapshot never
 * overwrites a newer one. A failed write keeps its changes pending and is tried again; closing
 * tries a few more times before giving up, and says so loudly when it must.
 */
export class SaveScheduler<S> {
  private timer?: NodeJS.Timeout;
  private pending?: () => S;
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly delayMs: number;
  private readonly retryMs: number;
  private readonly closeRetries: number;

  constructor(
    private readonly write: (snapshot: S) => Promise<void>,
    private readonly opts: SaveSchedulerOptions,
  ) {
    this.delayMs = opts.delayMs ?? 200;
    this.retryMs = opts.retryMs ?? 5_000;
    this.closeRetries = opts.closeRetries ?? 3;
  }

  /** Save soon; `snapshot` is called when the write happens, so it sees the latest state. */
  schedule(snapshot: () => S): void {
    if (this.closed) return;
    this.pending = snapshot;
    this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
  }

  /** Write any scheduled save now. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const snapshot = this.pending;
    this.pending = undefined;
    if (snapshot) this.writes = this.writes.then(() => this.run(snapshot));
    return this.writes;
  }

  private async run(snapshot: () => S): Promise<void> {
    try {
      await this.write(snapshot());
    } catch (err) {
      // A newer snapshot scheduled meanwhile already covers these changes.
      this.pending ??= snapshot;
      if (this.closed) return;
      log.error(`saving ${this.opts.what} failed (${(err as Error).message}); trying again in ${this.retryMs / 1000}s`);
      this.timer ??= setTimeout(() => void this.flush(), this.retryMs);
    }
  }

  /** Write what is pending (trying a failed write again a few times), then ignore further changes. */
  async close(): Promise<void> {
    await this.flush();
    for (let attempt = 0; this.pending && attempt < this.closeRetries; attempt++) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await new Promise((r) => setTimeout(r, Math.min(this.retryMs, 1_000)));
      await this.flush();
    }
    this.closed = true;
    clearTimeout(this.timer);
    if (this.pending) log.error(`saving ${this.opts.what} failed while the Hub was stopping: its latest changes are lost`);
  }
}
