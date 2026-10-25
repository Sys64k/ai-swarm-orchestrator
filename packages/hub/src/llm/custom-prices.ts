import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createLogger } from "@aso/shared";
import { JsonFileWriter } from "../push/json-file.js";
import { setCustomPrices } from "./pricing.js";

const log = createLogger("prices");

const FILE = "prices.json";
const PricesFileSchema = z.record(z.string(), z.object({ input: z.number().min(0), output: z.number().min(0) }));
type PricesFile = z.infer<typeof PricesFileSchema>;

/**
 * Prices set on the Hub for models it has no price for (or a different one), so task budgets
 * stop them too. USD per million tokens, per model name, in `<state>/prices.json`.
 */
export class CustomPrices {
  private readonly writer: JsonFileWriter | undefined;

  private constructor(
    private prices: PricesFile,
    file?: string,
  ) {
    this.writer = file ? new JsonFileWriter(file) : undefined;
    setCustomPrices(prices);
  }

  static async open(dir: string | undefined): Promise<CustomPrices> {
    const file = dir ? path.join(dir, FILE) : undefined;
    let prices: PricesFile = {};
    if (file) {
      try {
        prices = PricesFileSchema.parse(JSON.parse(await readFile(file, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`${file} is unreadable, starting with the built-in prices only: ${(err as Error).message}`);
      }
    }
    return new CustomPrices(prices, file);
  }

  async set(model: string, price: { input: number; output: number }): Promise<void> {
    await this.save({ ...this.prices, [model]: { input: price.input, output: price.output } });
  }

  /** False when no price was set for it. */
  async remove(model: string): Promise<boolean> {
    if (!Object.hasOwn(this.prices, model)) return false;
    const { [model]: _gone, ...rest } = this.prices;
    await this.save(rest);
    return true;
  }

  private async save(next: PricesFile): Promise<void> {
    await this.writer?.save(next);
    this.prices = next;
    setCustomPrices(next);
  }
}
