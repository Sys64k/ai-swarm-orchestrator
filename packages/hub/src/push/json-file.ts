import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@aso/shared";

const log = createLogger("push");

/**
 * Saves one JSON file atomically (temp file, then rename), one write at a time, so an older
 * state never lands after a newer one. `write` logs a failure; `save` throws it, for state
 * whose loss the caller must report (a worker key, a revocation, a model profile).
 */
export class JsonFileWriter {
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly mode?: number,
  ) {}

  /** Serialises `data` now; resolves once this write (and all before it) is done. A failure is logged. */
  write(data: unknown): Promise<unknown> {
    return this.save(data).catch((err: Error) => log.warn(`could not save ${this.file}: ${err.message}`));
  }

  /** Like `write`, but rejects when this write fails (later writes still run). */
  save(data: unknown): Promise<void> {
    const json = JSON.stringify(data, null, 2);
    const run = this.saving.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, json, this.mode === undefined ? undefined : { mode: this.mode });
      await rename(`${this.file}.tmp`, this.file);
    });
    this.saving = run.catch(() => undefined);
    return run;
  }
}
