import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@aso/shared";

const log = createLogger("push");

/**
 * Saves one JSON file atomically (temp file, then rename), one write at a time, so an older
 * state never lands after a newer one. A failed write is logged, not thrown.
 */
export class JsonFileWriter {
  private saving: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly mode?: number,
  ) {}

  /** Serialises `data` now; resolves once this write (and all before it) is done. */
  write(data: unknown): Promise<unknown> {
    const json = JSON.stringify(data, null, 2);
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.tmp`, json, this.mode === undefined ? undefined : { mode: this.mode });
        await rename(`${this.file}.tmp`, this.file);
      } catch (err) {
        log.warn(`could not save ${this.file}: ${(err as Error).message}`);
      }
    });
    return this.saving;
  }
}
