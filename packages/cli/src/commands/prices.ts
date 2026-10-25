import { hubHttpBase, type PriceEntry } from "@aso/shared";
import { api } from "../hub-api.js";

/** One line per price, for `aso prices`. */
export function priceLines(prices: PriceEntry[]): string[] {
  return prices.map((p) => `${p.model}  $${p.input} in / $${p.output} out per million tokens${p.source === "set" ? "  (set on this Hub)" : ""}`);
}

/** `aso prices`. */
export async function pricesCommand(opts: { hub: string }): Promise<void> {
  console.log(priceLines(await api<PriceEntry[]>(hubHttpBase(opts.hub), "/api/prices")).join("\n"));
}

/** `aso price set <model> --input <usd> --output <usd>`. */
export async function setPriceCommand(model: string, opts: { hub: string; input: number; output: number }): Promise<void> {
  const set = await api<PriceEntry>(hubHttpBase(opts.hub), "/api/prices", { method: "POST", body: JSON.stringify({ model, input: opts.input, output: opts.output }) });
  console.log(`${set.model}: $${set.input} in / $${set.output} out per million tokens`);
}

/** `aso price remove <model>`. */
export async function removePriceCommand(model: string, opts: { hub: string }): Promise<void> {
  await api<PriceEntry[]>(hubHttpBase(opts.hub), "/api/prices/remove", { method: "POST", body: JSON.stringify({ model }) });
  console.log(`removed the price set for ${model}`);
}
