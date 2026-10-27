import { accumulateChunks, createLogger, sseData, type ChatAnswer, type LocalModel } from "@aso/shared";

const log = createLogger("local-model");

/** How long one answer from the local model may take (a large model on a small GPU is slow). */
const CALL_TIMEOUT_MS = 30 * 60_000;

/** This machine's own model server (OpenAI-compatible, e.g. Ollama at http://localhost:11434/v1). */
export interface LocalModelServer {
  url: string;
  /** Its models accept images. */
  vision?: boolean;
  /** The model this machine's desks use by default (default: the first it lists). */
  default?: string;
}

/** The models the server lists (`GET /models`); none when it can't be reached (logged). */
export async function listLocalModels(server: LocalModelServer, fetchFn: typeof fetch = fetch): Promise<LocalModel[]> {
  const base = server.url.replace(/\/+$/, "");
  try {
    const res = await fetchFn(`${base}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? []).flatMap((m) => (typeof m.id === "string" && m.id ? [m.id] : []));
    return ids.slice(0, 50).map((id) => ({ id, ...(server.vision ? { vision: true } : {}) }));
  } catch (err) {
    log.warn(`the local model server at ${base} can't be listed (${(err as Error).message}); offering no local models`);
    return [];
  }
}

export type LocalAnswer = { outcome: "ok"; answer: ChatAnswer } | { outcome: "error"; error: string; retryable: boolean };

/**
 * Make a model call for the Hub on this machine's own server: only that server, and only a
 * model it listed, whatever the Hub asks. The request is streamed and added up here.
 */
export async function callLocalModel(
  server: LocalModelServer,
  offered: readonly LocalModel[],
  model: string,
  request: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<LocalAnswer> {
  if (!offered.some((m) => m.id === model)) return { outcome: "error", error: `this machine doesn't offer the model ${model}`, retryable: false };
  const base = server.url.replace(/\/+$/, "");
  let res: Response;
  let body: string;
  try {
    res = await fetchFn(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, model, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    body = await res.text();
  } catch (err) {
    return { outcome: "error", error: `this machine's model server is unreachable: ${(err as Error).message}`, retryable: true };
  }
  if (!res.ok) {
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    return { outcome: "error", error: `this machine's model server answered HTTP ${res.status}: ${body.slice(0, 300)}`, retryable };
  }
  return { outcome: "ok", answer: accumulateChunks(sseData(body)) };
}
