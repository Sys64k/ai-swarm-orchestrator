import { randomUUID } from "node:crypto";
import { createLogger, type LocalModel, type MessageOf, type PayloadInput } from "@aso/shared";
import { LlmError, type LlmAdapter, type LlmRequest, type LlmResponse } from "./adapter.js";
import { chatRequest, fromChatAnswer } from "./openai-compatible.js";
import { Semaphore } from "./semaphore.js";
import type { Route } from "./desk-models.js";

const log = createLogger("machine-models");

/** Model specs for a machine's own models: `machine/<model>`, "the model on the machine running this job". */
export const MACHINE_PREFIX = "machine/";
/** How long the Hub waits for a machine's answer (its local model may be slow). */
const CALL_TIMEOUT_MS = 31 * 60_000;

type Answer = MessageOf<"MODEL_ANSWER">["payload"];

/**
 * Models worker machines serve themselves (a volunteer's GPU). The Hub keeps the conversation and
 * sends each finished Chat Completions request over the machine's own connection (MODEL_CALL);
 * the machine calls its local server and answers (MODEL_ANSWER). A machine's models serve only
 * that machine's jobs, one call at a time each, and cost the Hub nothing.
 */
export class MachineModels {
  private readonly machines = new Map<string, { models: LocalModel[]; default?: string }>();
  private readonly pending = new Map<string, { nodeId: string; resolve: (a: Answer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly routes = new Map<string, Route>();

  constructor(
    private readonly send: (nodeId: string, payload: PayloadInput<"MODEL_CALL">) => void,
    private readonly maxTokens: number,
  ) {}

  /** A worker registered: what it serves (nothing when it lists no models). */
  register(nodeId: string, models: readonly LocalModel[] | undefined, defaultModel?: string): void {
    this.forget(nodeId);
    if (!models?.length) return;
    this.machines.set(nodeId, { models: [...models], ...(defaultModel ? { default: defaultModel } : {}) });
    log.info(`${nodeId} serves its own models: ${models.map((m) => m.id).join(", ")}${defaultModel ? ` (its desks use ${defaultModel})` : ""}`);
  }

  /** A machine left: its models go with it, and calls waiting on it fail (to be tried again). */
  forget(nodeId: string): void {
    this.machines.delete(nodeId);
    for (const key of [...this.routes.keys()]) if (key.startsWith(`${nodeId}\n`)) this.routes.delete(key);
    for (const [callId, p] of this.pending) {
      if (p.nodeId !== nodeId) continue;
      clearTimeout(p.timer);
      this.pending.delete(callId);
      p.reject(new LlmError(`${nodeId} disconnected during a call to its own model`, true));
    }
  }

  /** Whether `nodeId` serves `model` itself. */
  serves(nodeId: string, model: string): boolean {
    return this.machines.get(nodeId)?.models.some((m) => m.id === model) ?? false;
  }

  /** The spec a machine's desks use by default (its chosen local model); undefined when it serves none. */
  defaultSpec(nodeId: string): string | undefined {
    const m = this.machines.get(nodeId);
    const model = m?.default ?? m?.models[0]?.id;
    return model ? `${MACHINE_PREFIX}${model}` : undefined;
  }

  /** The model and its limit for a `machine/<model>` spec on `nodeId`; throws when that machine doesn't serve it. */
  route(nodeId: string, spec: string): Route {
    const model = spec.slice(MACHINE_PREFIX.length);
    const offered = this.machines.get(nodeId)?.models.find((m) => m.id === model);
    if (!offered) throw new Error(`${nodeId} doesn't serve ${model}`);
    const key = `${nodeId}\n${model}`;
    let route = this.routes.get(key);
    if (!route) {
      route = { adapter: new MachineModelAdapter(nodeId, offered, this.maxTokens, (payload) => this.call(nodeId, payload)), slots: new Semaphore(1) };
      this.routes.set(key, route);
    }
    return route;
  }

  /** A machine's answer; an error string when no call of that machine is waiting for it. */
  answer(nodeId: string, payload: Answer): string | undefined {
    const p = this.pending.get(payload.callId);
    if (!p || p.nodeId !== nodeId) return `no model call ${payload.callId} is waiting for ${nodeId}`;
    clearTimeout(p.timer);
    this.pending.delete(payload.callId);
    p.resolve(payload);
    return undefined;
  }

  private call(nodeId: string, payload: Omit<PayloadInput<"MODEL_CALL">, "callId">): Promise<Answer> {
    const callId = randomUUID();
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new LlmError(`${nodeId}'s own model didn't answer within ${Math.round(CALL_TIMEOUT_MS / 60_000)} minutes`, true));
      }, CALL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(callId, { nodeId, resolve, reject, timer });
      try {
        this.send(nodeId, { callId, ...payload });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(new LlmError(`can't reach ${nodeId}: ${(err as Error).message}`, true));
      }
    });
  }
}

/**
 * What a desk put on `machine/<model>` holds in DeskModels: only its name. Calls are routed per
 * machine by MachineModels (ConversationManager), never through this.
 */
export function machineDeskAdapter(spec: string): LlmAdapter {
  return {
    name: "machine",
    model: spec,
    complete: () => Promise.reject(new LlmError(`${spec} is called on its machine, not through a desk`, false)),
  };
}

/** A machine's own model, called over its connection. */
class MachineModelAdapter implements LlmAdapter {
  readonly name = "machine";
  readonly model: string;

  constructor(
    private readonly nodeId: string,
    private readonly offered: LocalModel,
    private readonly maxTokens: number,
    private readonly call: (payload: Omit<PayloadInput<"MODEL_CALL">, "callId">) => Promise<Answer>,
  ) {
    this.model = `${MACHINE_PREFIX}${offered.id}`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const request = chatRequest(req, { model: this.offered.id, maxTokens: this.maxTokens, vision: this.offered.vision ?? false });
    const answer = await this.call({ model: this.offered.id, request });
    if (answer.outcome === "error") throw new LlmError(`${this.nodeId}: ${answer.error}`, answer.retryable);
    // Named machine/<model>: no price applies, so it costs the Hub (and the key's budget) nothing.
    return fromChatAnswer({ ...answer.answer, model: undefined }, this.model);
  }
}
