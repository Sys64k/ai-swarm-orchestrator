import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger, ScreenshotNameSchema, type MessageOf } from "@aso/shared";

const log = createLogger("screenshots");

const SAFE_TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Incoming = NonNullable<Extract<MessageOf<"FEEDBACK_LOOP">["payload"], { outcome: "pass" }>["screenshots"]>;

/** What a task record keeps about its screenshots; the images themselves stay in the store. */
export interface ScreenshotSet {
  commit: string;
  at: string;
  files: Array<{ name: string; mediaType: string; bytes: number }>;
}

/**
 * The screenshots of each task's last passing QA run, in `<stateDir>/screenshots/<taskId>/`.
 * A new set replaces the old one: screenshots of an earlier commit would mislead a reviewer.
 * Without a directory (state not persisted) they are kept in memory.
 */
export class Screenshots {
  private readonly memory = new Map<string, Map<string, Buffer>>();
  /** Writes per task, in order, so a read never sees half a set. */
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly dir?: string) {}

  /** Store a new set for `taskId`, replacing any earlier one. */
  save(taskId: string, commit: string, incoming: Incoming): ScreenshotSet {
    const images = new Map(incoming.map((s) => [s.name, Buffer.from(s.data, "base64")]));
    const set: ScreenshotSet = {
      commit,
      at: new Date().toISOString(),
      files: incoming.map((s) => ({ name: s.name, mediaType: s.mediaType, bytes: images.get(s.name)!.length })),
    };
    if (!SAFE_TASK_ID.test(taskId)) return set;
    if (!this.dir) {
      this.memory.set(taskId, images);
      return set;
    }
    const folder = path.join(this.dir, taskId);
    this.queue(taskId, async () => {
      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { recursive: true });
      for (const [name, data] of images) await writeFile(path.join(folder, name), data);
    });
    return set;
  }

  /** Forget a task's screenshots (e.g. a later QA run took none). */
  clear(taskId: string): void {
    this.memory.delete(taskId);
    if (this.dir && SAFE_TASK_ID.test(taskId)) {
      const folder = path.join(this.dir, taskId);
      this.queue(taskId, () => rm(folder, { recursive: true, force: true }));
    }
  }

  /** One image, or undefined when the task has no screenshot of that name. */
  async read(taskId: string, name: string): Promise<Buffer | undefined> {
    if (!SAFE_TASK_ID.test(taskId) || !ScreenshotNameSchema.safeParse(name).success) return undefined;
    if (!this.dir) return this.memory.get(taskId)?.get(name);
    await this.writes.get(taskId);
    return readFile(path.join(this.dir, taskId, name)).catch(() => undefined);
  }

  /** Wait for pending writes (the Hub is stopping, or a test wants the files on disk). */
  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  private queue(taskId: string, write: () => Promise<unknown>): void {
    const next = (this.writes.get(taskId) ?? Promise.resolve())
      .then(write)
      .catch((err: Error) => log.warn(`could not store screenshots of ${taskId}: ${err.message}`));
    this.writes.set(taskId, next);
    void next.then(() => {
      if (this.writes.get(taskId) === next) this.writes.delete(taskId);
    });
  }
}
