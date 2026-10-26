import { hubHttpBase, type PriceEntry } from "@aso/shared";
import { api } from "../hub-api.js";

/** One line per price, for `aso prices`. */
export function priceLines(prices: PriceEntry[]): string[] {
  return prices.map((p) => {
    const cache = p.cacheRead !== p.input || p.cacheWrite !== p.input ? ` / $${p.cacheRead} cache read / $${p.cacheWrite} cache write` : "";
    return `${p.model}  $${p.input} in / $${p.output} out${cache} per million tokens${p.source === "set" ? "  (set on this Hub)" : ""}`;
  });
}

/** `aso prices`. */
export async function pricesCommand(opts: { hub: string }): Promise<void> {
  console.log(priceLines(await api<PriceEntry[]>(hubHttpBase(opts.hub), "/api/prices")).join("\n"));
}

/** `aso price set <model> --input <usd> --output <usd> [--cache-read <usd>] [--cache-write <usd>]`. */
export async function setPriceCommand(model: string, opts: { hub: string; input: number; output: number; cacheRead?: number; cacheWrite?: number }): Promise<void> {
  const body = { model, input: opts.input, output: opts.output, ...(opts.cacheRead === undefined ? {} : { cacheRead: opts.cacheRead }), ...(opts.cacheWrite === undefined ? {} : { cacheWrite: opts.cacheWrite }) };
  const set = await api<PriceEntry>(hubHttpBase(opts.hub), "/api/prices", { method: "POST", body: JSON.stringify(body) });
  console.log(priceLines([set])[0]);
}

/** `aso price remove <model>`. */
export async function removePriceCommand(model: string, opts: { hub: string }): Promise<void> {
  await api<PriceEntry[]>(hubHttpBase(opts.hub), "/api/prices/remove", { method: "POST", body: JSON.stringify({ model }) });
  console.log(`removed the price set for ${model}`);
}
