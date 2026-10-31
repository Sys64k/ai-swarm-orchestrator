import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger, NoticeSchema, type Notice, type Notices } from "@aso/shared";
import type { PushNotification } from "./changes.js";
import { JsonFileWriter } from "./json-file.js";

const log = createLogger("push");

/** Notices the Hub keeps; older ones are dropped. */
export const MAX_NOTICES = 500;
/** What `list` gives without a limit. */
export const DEFAULT_NOTICE_LIMIT = 50;

interface NoticeFile {
  notices: Notice[];
  /** The newest notice a person marked read. */
  readId?: string;
}

export interface NoticeLogOptions {
  /** Folder for `notices.json`. Undefined keeps them in memory. */
  dir?: string;
  max?: number;
}

/**
 * Everything the Hub has told you about (kept oldest first; `list` gives newest first), so it can be read again in the console,
 * the API or the CLI: a push notification is only one way to hear of it, and one missed is gone.
 */
export class NoticeLog {
  private readonly writer?: JsonFileWriter;

  private constructor(
    private readonly data: NoticeFile,
    private readonly opts: NoticeLogOptions,
  ) {
    if (opts.dir) this.writer = new JsonFileWriter(path.join(opts.dir, "notices.json"));
  }

  static async open(opts: NoticeLogOptions = {}): Promise<NoticeLog> {
    const file = opts.dir && path.join(opts.dir, "notices.json");
    let data: NoticeFile = { notices: [] };
    if (file) {
      try {
        data = parseNoticeFile(JSON.parse(await readFile(file, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`could not read ${file} (${(err as Error).message}); starting without earlier notices`);
      }
    }
    return new NoticeLog(data, opts);
  }

  /** Keep `n` as a notice. */
  add(n: PushNotification, now = new Date()): Notice {
    const notice: Notice = { id: randomUUID(), at: now.toISOString(), title: n.title, body: n.body, url: n.url, tag: n.tag };
    this.data.notices.push(notice);
    const max = this.opts.max ?? MAX_NOTICES;
    if (this.data.notices.length > max) this.data.notices.splice(0, this.data.notices.length - max);
    void this.save();
    return notice;
  }

  /** Whether any notice kept has this tag (one per day's spending, say). */
  has(tag: string): boolean {
    return this.data.notices.some((n) => n.tag === tag);
  }

  /** The latest `limit` notices, newest first, and how many are unread. */
  list(limit = DEFAULT_NOTICE_LIMIT): Notices {
    const notices = this.data.notices.slice(-limit).reverse();
    return { notices, unread: this.unread() };
  }

  /**
   * Mark the notice `upTo` (default: the newest) read, with all before it. Never moves the mark
   * back. False when there is no such notice.
   */
  markRead(upTo?: string): boolean {
    const to = upTo === undefined ? this.data.notices.length - 1 : this.data.notices.findIndex((n) => n.id === upTo);
    if (to < 0) return upTo === undefined; // nothing to mark is fine; an unknown id isn't
    if (to <= this.readIndex()) return true;
    this.data.readId = this.data.notices[to].id;
    void this.save();
    return true;
  }

  /** Resolves once the notices are on disk. */
  async flush(): Promise<void> {
    await this.writer?.idle();
  }

  private unread(): number {
    return this.data.notices.length - 1 - this.readIndex();
  }

  /** Where the read mark is; -1 with none, or when that notice was dropped as too old (everything kept is newer). */
  private readIndex(): number {
    return this.data.readId === undefined ? -1 : this.data.notices.findIndex((n) => n.id === this.data.readId);
  }

  private save(): Promise<unknown> {
    return this.writer?.write(this.data) ?? Promise.resolve();
  }
}

/** The notices in a saved file that are still valid; anything else is left out. */
function parseNoticeFile(raw: unknown): NoticeFile {
  const f = raw as Partial<NoticeFile> | null;
  const notices = Array.isArray(f?.notices) ? f.notices.filter((n): n is Notice => NoticeSchema.safeParse(n).success) : [];
  return { notices, ...(typeof f?.readId === "string" ? { readId: f.readId } : {}) };
}
