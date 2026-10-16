import type { PlannedTask } from "./protocol.js";

/** The back-and-forth between the Architect and the person on one plan, oldest first. */
export type PlanDialogueEntry =
  | { kind: "questions"; at: string; questions: string[]; context?: string }
  /** A proposal the person answered with changes (the current one is the plan's `summary` + `tasks`). */
  | { kind: "proposal"; at: string; summary: string; tasks: PlannedTask[] }
  | { kind: "reply"; at: string; text: string };

/** Replies per plan: every reply is another planning round, and each round costs a model run. */
export const MAX_PLAN_REPLIES = 10;
export const MAX_PLAN_REPLY_LENGTH = 10_000;

/** Replies so far, which is also the planning round (0 for the first run). */
export function countReplies(dialogue: readonly PlanDialogueEntry[] | undefined): number {
  return dialogue?.filter((d) => d.kind === "reply").length ?? 0;
}

/** What a reply means in this state: answering questions, asking for changes, or not possible. */
export function replyMode(state: string, dialogue: readonly PlanDialogueEntry[] | undefined): "answer" | "changes" | undefined {
  if (countReplies(dialogue) >= MAX_PLAN_REPLIES) return undefined;
  if (state === "awaiting_input") return "answer";
  if (state === "proposed") return "changes";
  return undefined;
}

/** Whether the latest reply asked for changes to a proposal (rather than answering questions). */
export function lastReplyAsksForChanges(dialogue: readonly PlanDialogueEntry[]): boolean {
  return dialogue.at(-1)?.kind === "reply" && dialogue.at(-2)?.kind === "proposal";
}
