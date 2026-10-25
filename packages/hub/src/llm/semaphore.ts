/** At most `limit` calls at once; the rest wait their turn, first come first served. */
export class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  status() {
    return { running: this.running, waiting: this.waiting.length, limit: this.limit };
  }
}
