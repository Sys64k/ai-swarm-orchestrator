import { randomUUID } from "node:crypto";
import { createLogger, type MessageOf, type PayloadInput } from "@aso/shared";
import type { Send } from "./jobs.js";

const log = createLogger("model");

export type ModelTurn = Omit<PayloadInput<"PROMPT_EXECUTION">, "requestId" | "taskId" | "planId">;
export type ModelReply = MessageOf<"PROMPT_RESULT">["payload"];
export type ModelSubject = { taskId: string } | { planId: string };

interface Pending {
  message: PayloadInput<"PROMPT_EXECUTION">;
  resolve(reply: ModelReply): void;
}

/**
 * Request/response over the Hub socket for model turns. Pending requests survive reconnects:
 * `resendPending` asks again and the Hub answers duplicates from its cache.
 */
export class ModelChannel {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly send: Send,
    /** Long agentic turns can take minutes; past this the Hub has certainly lost the request. */
    private readonly timeoutMs = 20 * 60_000,
  ) {}

  call(subject: ModelSubject, turn: ModelTurn): Promise<ModelReply> {
    const message = { ...turn, ...subject, requestId: randomUUID() } as PayloadInput<"PROMPT_EXECUTION">;
    return new Promise<ModelReply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.requestId);
        resolve({ requestId: message.requestId, outcome: "error", error: "no answer from the Hub", retryable: true });
      }, this.timeoutMs);
      this.pending.set(message.requestId, {
        message,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      this.send("PROMPT_EXECUTION", message);
    });
  }

  handleResult(reply: ModelReply): void {
    const pending = this.pending.get(reply.requestId);
    if (!pending) return log.debug(`ignoring result for unknown prompt ${reply.requestId}`);
    this.pending.delete(reply.requestId);
    pending.resolve(reply);
  }

  resendPending(): void {
    for (const p of this.pending.values()) this.send("PROMPT_EXECUTION", p.message);
  }
}
