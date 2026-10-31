import type { DaySpend } from "../llm/conversations.js";
import type { PushNotification } from "./changes.js";

/** The day's model spending worth a notice when none is configured. */
export const DEFAULT_DAILY_SPEND_ALERT_USD = 25;

/** The daily limit from the environment (`ASO_DAILY_SPEND_ALERT_USD`): a number of USD, 0 turning it off; else the default. */
export function spendLimitFromEnv(raw: string | undefined): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_SPEND_ALERT_USD;
}

/**
 * The notice for a day's model spending at or over `limitUsd`. Its tag names the day, so the
 * notices already kept say whether it was told (across restarts too).
 */
export function spendingNotice(today: DaySpend, limitUsd: number): PushNotification | undefined {
  if (!(limitUsd > 0) || today.costUsd < limitUsd) return undefined;
  return {
    title: `Model spending today is $${today.costUsd.toFixed(2)}`,
    body: `Over the daily limit of $${limitUsd.toFixed(2)} (${today.date}, UTC). Track records show where it went.`,
    url: "/track-records",
    tag: `spend-${today.date}`,
  };
}
