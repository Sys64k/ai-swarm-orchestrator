import { simpleGit, type SimpleGit } from "simple-git";
import { createLogger } from "@aso/shared";
import type { HubRepository } from "./hub-repo.js";

const log = createLogger("sync");

export interface SyncStatus {
  enabled: boolean;
  remote: string;
  /** Remote URL with any credentials stripped. */
  url: string | null;
  /** Why pushing is off or failing, if it is. */
  reason?: string;
  state: "disabled" | "idle" | "pushing" | "error" | "conflict";
  lastPushAt?: string;
  lastPushedCommit?: string;
  lastError?: string;
}

export interface SyncOptions {
  enabled: boolean;
  remote?: string;
  /**
   * Token for HTTPS remotes (e.g. a GitHub fine-grained token with contents:write). Sent as a
   * Basic auth header scoped to the remote's host; never written to .git/config.
   */
  token?: string;
  /** Retry interval after a failed (non-conflict) push. */
  retryMs?: number;
}

/**
 * Keeps the remote (e.g. GitHub) in step with the Hub's main: pushes after every merge.
 * If the remote moved, its commits are merged in first; a conflict stops syncing until fixed.
 */
export class GitSync {
  private readonly remote: string;
  private status_: SyncStatus;
  private running?: Promise<void>;
  private again = false;
  private retryTimer?: NodeJS.Timeout;
  private listeners: Array<(result: { ok: boolean; commit?: string; error?: string }) => void> = [];

  private constructor(
    private readonly repo: HubRepository,
    private readonly opts: SyncOptions,
    url: string | null,
  ) {
    this.remote = opts.remote ?? "origin";
    const disabled = !opts.enabled ? "pushing disabled (--no-push)" : url === null ? `no "${this.remote}" remote; merges stay local` : undefined;
    this.status_ = {
      enabled: !disabled,
      remote: this.remote,
      url: url && sanitizeUrl(url),
      state: disabled ? "disabled" : "idle",
      reason: disabled,
    };
  }

  static async create(repo: HubRepository, opts: SyncOptions): Promise<GitSync> {
    // A server must never block on an interactive credential prompt. Set for the process (and
    // inherited by git children) rather than via simple-git's env(), which rejects common
    // inherited variables such as GIT_ASKPASS.
    process.env.GIT_TERMINAL_PROMPT = "0";
    const url = (await simpleGit(repo.dir).raw(["remote", "get-url", opts.remote ?? "origin"]).catch(() => "")).trim() || null;
    const sync = new GitSync(repo, opts, url);
    log.info(sync.status_.enabled ? `pushing ${repo.mainBranch} to ${sync.status_.remote} (${sync.status_.url})` : sync.status_.reason!);
    return sync;
  }

  status(): SyncStatus {
    return { ...this.status_ };
  }

  /** Called after each merge; pushes are coalesced so a burst of merges means one push. */
  onResult(listener: (result: { ok: boolean; commit?: string; error?: string }) => void): void {
    this.listeners.push(listener);
  }

  requestPush(): Promise<void> {
    if (!this.status_.enabled) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    clearTimeout(this.retryTimer);
    this.running = this.pushLoop().finally(() => (this.running = undefined));
    return this.running;
  }

  stop(): void {
    clearTimeout(this.retryTimer);
  }

  /** The remote's URL (with any credentials), or undefined when it has none. */
  async remoteUrl(): Promise<string | undefined> {
    return (await simpleGit(this.repo.dir).raw(["remote", "get-url", this.remote]).catch(() => "")).trim() || undefined;
  }

  /**
   * Put `commit` on the remote's `branch` (forced: the Hub decides what the task is). The commit,
   * not the Hub's branch: that is what QA passed, whatever was pushed to the branch since.
   */
  async pushBranch(branch: string, commit: string): Promise<void> {
    const git = await this.client();
    await git.raw(["push", "--force", this.remote, `${commit}:refs/heads/${branch}`]).catch((err: Error) => {
      throw new Error(`push of ${branch} to ${this.remote} failed: ${firstLine(err.message)}`);
    });
  }

  /**
   * Bring the Hub's main up to the remote's, after a pull request was merged there: a fast
   * forward, or a merge when the Hub has commits of its own (then pushed).
   */
  async catchUp(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const git = await this.client();
    const main = this.repo.mainBranch;
    const result = await this.repo.withMainLock(async () => {
      try {
        await git.fetch(this.remote, main);
      } catch (err) {
        return { error: `fetch from ${this.remote} failed: ${firstLine((err as Error).message)}` };
      }
      const forwarded = await this.repo.fastForward(`${this.remote}/${main}`);
      if (forwarded.ok) return {};
      if (forwarded.reason !== "diverged") return { error: forwarded.reason };
      const merged = await this.repo.mergeRemoteMain(this.remote, git);
      return merged.ok ? { push: true } : { error: merged.reason };
    });
    if (result.push) void this.requestPush();
    return result.error ? { ok: false, reason: result.error } : { ok: true };
  }

  private async pushLoop(): Promise<void> {
    do {
      this.again = false;
      this.status_.state = "pushing";
      const result = await this.repo.withMainLock(() => this.pushOnce());
      for (const l of this.listeners) l(result);
      if (result.ok) {
        this.status_ = { ...this.status_, state: "idle", lastPushAt: new Date().toISOString(), lastPushedCommit: result.commit, lastError: undefined };
      } else {
        this.status_ = { ...this.status_, state: result.conflict ? "conflict" : "error", lastError: result.error };
        log.warn(`push failed: ${result.error}`);
        if (!result.conflict) {
          this.retryTimer = setTimeout(() => void this.requestPush(), this.opts.retryMs ?? 5 * 60_000);
          this.retryTimer.unref();
        }
        return;
      }
    } while (this.again);
  }

  private async pushOnce(): Promise<{ ok: boolean; commit?: string; error?: string; conflict?: boolean }> {
    const git = await this.client();
    const main = this.repo.mainBranch;
    try {
      await git.push(this.remote, main);
    } catch (err) {
      const message = (err as Error).message;
      if (!/non-fast-forward|fetch first|rejected/i.test(message) || /protected branch|permission|denied|403/i.test(message)) {
        return { ok: false, error: firstLine(message) };
      }
      // The remote has commits we don't: bring them into main, then push again.
      log.info(`${this.remote}/${main} has new commits; merging them into ${main}`);
      const merged = await this.repo.mergeRemoteMain(this.remote, git);
      if (!merged.ok) return { ok: false, error: merged.reason, conflict: merged.conflict };
      try {
        await git.push(this.remote, main);
      } catch (err2) {
        return { ok: false, error: firstLine((err2 as Error).message) };
      }
    }
    const commit = await this.repo.mainHead();
    log.info(`pushed ${main} @ ${commit.slice(0, 8)} to ${this.remote}`);
    return { ok: true, commit };
  }

  private async client(): Promise<SimpleGit> {
    const config: string[] = [];
    const url = (await simpleGit(this.repo.dir).raw(["remote", "get-url", this.remote])).trim();
    if (this.opts.token && /^https?:\/\//.test(url)) {
      const { origin } = new URL(url);
      const basic = Buffer.from(`x-access-token:${this.opts.token}`).toString("base64");
      config.push(`http.${origin}/.extraHeader=Authorization: Basic ${basic}`);
    }
    return simpleGit({ baseDir: this.repo.dir, config });
  }
}

/** Drop user:password@ from URLs before showing or logging them. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
    }
    return u.toString();
  } catch {
    return url; // scp-style SSH remotes (git@host:owner/repo) carry no secret
  }
}

function firstLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" | ").slice(0, 500);
}
