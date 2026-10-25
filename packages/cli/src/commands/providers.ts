import { hubHttpBase, PRESET_INFO, type ProviderPreset, type ProviderView } from "@aso/shared";
import { api } from "../hub-api.js";
import { readSecret } from "../prompt.js";

/** One line per provider, for `aso providers`. */
export function providerLines(providers: ProviderView[]): string[] {
  if (!providers.length) return ["No providers yet: add one, e.g. `aso provider add anthropic` (it asks for the key)."];
  return providers.map((p) => {
    const where = p.baseUrl && PRESET_INFO[p.preset].local ? ` at ${p.baseUrl}` : "";
    const from = p.source === "environment" ? ", from the Hub's .env" : "";
    const state = p.error ? `: ${p.error}` : `: ${p.models ?? 0} models`;
    return `${p.id}  ${p.label}${where}${from}${state}`;
  });
}

/** `aso providers`. */
export async function providersCommand(opts: { hub: string }): Promise<void> {
  console.log(providerLines(await api<ProviderView[]>(hubHttpBase(opts.hub), "/api/providers")).join("\n"));
}

/** `aso provider add <preset>`: the key is asked for (hidden) unless given. */
export async function addProviderCommand(
  preset: ProviderPreset,
  opts: { hub: string; key?: string; url?: string; name?: string; vision?: boolean },
): Promise<void> {
  const { keyRequired } = PRESET_INFO[preset];
  const key = opts.key ?? (keyRequired ? await readSecret(`${preset} API key (not shown): `) : undefined);
  if (keyRequired && !key) throw new Error("no key given");
  const body = {
    preset,
    ...(opts.name ? { id: opts.name } : {}),
    ...(key ? { key } : {}),
    ...(opts.url ? { baseUrl: opts.url } : {}),
    ...(opts.vision ? { vision: true } : {}),
  };
  const added = await api<ProviderView>(hubHttpBase(opts.hub), "/api/providers", { method: "POST", body: JSON.stringify(body) });
  console.log(`added ${added.id} (${added.label}): ${added.models ?? 0} models. See them with \`aso models\`; put a desk on one with \`aso desk <host>#<slot> ${added.id}/<model>\`.`);
}

/** `aso provider remove <id>`. */
export async function removeProviderCommand(id: string, opts: { hub: string }): Promise<void> {
  await api<{ removed: string }>(hubHttpBase(opts.hub), `/api/providers/${encodeURIComponent(id)}/remove`, { method: "POST" });
  console.log(`removed ${id}; its key is forgotten`);
}
