import type Anthropic from "@anthropic-ai/sdk";
import type { LlmAdapter } from "./adapter.js";

const READY: Anthropic.Beta.BetaTool = { name: "ready", description: "Say that you are ready.", input_schema: { type: "object", properties: {} } };

/**
 * One small call with a tool, as the Hub calls models for its roles: throws, saying why, when the
 * model refuses such a request (e.g. an OpenAI model that takes tools only on its Responses API).
 * Answering without calling the tool is fine: the request was taken.
 */
export async function checkToolUse(adapter: LlmAdapter): Promise<void> {
  try {
    await adapter.complete({ system: "You are checking that tools work.", tools: [READY], messages: [{ role: "user", content: "Call the ready tool." }] });
  } catch (err) {
    throw new Error(`${adapter.model} can't take the Hub's requests with tools: ${(err as Error).message}`);
  }
}
