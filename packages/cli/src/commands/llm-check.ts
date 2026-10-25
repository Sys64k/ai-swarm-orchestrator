import { AnthropicApiAdapter, LlmError, OPENAI_PREFIX, openAiCompatibleFor, priceUsage, type LlmAdapter } from "@aso/hub";

/** A tool the model must call: agents work only through tool calls, so this is what matters most. */
const CHECK_TOOL = {
  name: "report_status",
  description: "Report the status of the connectivity check.",
  input_schema: {
    type: "object" as const,
    properties: { status: { type: "string", enum: ["ok"], description: "Always ok" } },
    required: ["status"],
  },
};

function adapterFor(model: string): LlmAdapter {
  const openAi = openAiCompatibleFor(model, process.env, 1024);
  if (openAi) return openAi;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(`ANTHROPIC_API_KEY is not set (create a key in the Claude Console and export it), or check a model with ${OPENAI_PREFIX}<model> and ASO_LLM_BASE_URL`);
  }
  return new AnthropicApiAdapter({ model, effort: "low", maxTokens: 1024 });
}

/**
 * Two tiny requests: a one-word reply (the endpoint, credentials, model and credit), then a tool
 * call (whether the model can drive an agent).
 */
export async function llmCheckCommand(opts: { model: string }): Promise<void> {
  const adapter = adapterFor(opts.model);
  console.log(`asking ${adapter.model} (${adapter.name}) for a one-word reply...`);
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

    console.log("asking it to call a tool...");
    const tool = await adapter.complete({
      system: "You are a connectivity check. Call the report_status tool with status ok. Don't write anything else.",
      tools: [CHECK_TOOL],
      messages: [{ role: "user", content: "Run the check." }],
    });
    const call = tool.content.find((b) => b.type === "tool_use");
    if (call?.type === "tool_use" && call.name === CHECK_TOOL.name && (call.input as { status?: unknown }).status === "ok") {
      console.log("tool call: OK, the model can work as an agent.");
    } else {
      console.log(`tool call: FAILED (stop: ${tool.stopReason}). This model may not support tool calling; agents won't work with it.`);
      process.exitCode = 1;
      return;
    }
    console.log("LLM access works.");
  } catch (err) {
    if (err instanceof LlmError) throw new Error(`LLM check failed: ${err.message}`);
    throw err;
  }
}
