/**
 * One job per key at a time. A call while a job runs for the same `version` joins it (its result is
 * the running job's); one for another version runs after it, so the newest version is always done.
 */
export class OnePerKey<V> {
  private readonly running = new Map<string, { version: V; done: Promise<void> }>();

  run(key: string, version: V, job: () => Promise<void>): Promise<void> {
    const current = this.running.get(key);
    if (current && current.version === version) return current.done;
    // After the one before it, whether that succeeded or not: a newer version still needs doing.
    const done: Promise<void> = (current?.done.catch(() => undefined) ?? Promise.resolve()).then(job).finally(() => {
      if (this.running.get(key)?.done === done) this.running.delete(key);
    });
    this.running.set(key, { version, done });
    return done;
  }
}
