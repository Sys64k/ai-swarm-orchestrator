import { AnthropicApiAdapter, LlmError, priceUsage } from "@aso/hub";

/** One tiny request to confirm the API key, model access and credit balance. */
export async function llmCheckCommand(opts: { model: string }): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set (create a key in the Claude Console and export it)");
  }
  const adapter = new AnthropicApiAdapter({ model: opts.model, effort: "low", maxTokens: 1024 });
  console.log(`asking ${opts.model} for a one-word reply...`);
  try {
    const res = await adapter.complete({
      system: "You are a connectivity check. Reply with exactly: OK",
      tools: [],
      messages: [{ role: "user", content: "Connectivity check." }],
    });
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    const usage = priceUsage(res.model, res.tokens);
    console.log(`reply: ${JSON.stringify(text)} (stop: ${res.stopReason}, served by ${res.model})`);
    console.log(`tokens: ${usage.inputTokens} in / ${usage.outputTokens} out, estimated cost $${usage.costUsd.toFixed(5)}`);
    console.log("LLM access works.");
  } catch (err) {
    if (err instanceof LlmError) throw new Error(`LLM check failed: ${err.message}`);
    throw err;
  }
}
