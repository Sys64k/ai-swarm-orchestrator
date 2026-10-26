import type Anthropic from "@anthropic-ai/sdk";

/**
 * Where a tool call keeps data its provider needs back on the next turn, such as Gemini's thought
 * signature (`extra_content` in its OpenAI-compatible API). Stored with the conversation; sent
 * back only to the OpenAI-compatible API it came from.
 */
export const PROVIDER_DATA = "aso_provider_data";

/** The conversation without provider data, for an API that would refuse the unknown field (Anthropic's). */
export function withoutProviderData(messages: Anthropic.Beta.BetaMessageParam[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m) => {
    if (typeof m.content === "string" || !m.content.some((b) => PROVIDER_DATA in b)) return m;
    return { ...m, content: m.content.map((b) => (PROVIDER_DATA in b ? (({ [PROVIDER_DATA]: _gone, ...rest }) => rest)(b as typeof b & Record<string, unknown>) : b)) as typeof m.content };
  });
}
