import { z } from "zod";

const base64url = (bytes: number, what: string) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, `${what} must be URL-safe base64`)
    .refine((s) => Buffer.from(s, "base64url").length === bytes, `${what} must be ${bytes} bytes`);

/**
 * A browser's Web Push subscription (`PushSubscription.toJSON()`), as the console sends it to the
 * Hub. The endpoint is the push service URL the Hub posts to, so only https is accepted.
 */
export const PushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine((u) => {
      try {
        return new URL(u).protocol === "https:";
      } catch {
        return false;
      }
    }, "endpoint must be an https URL"),
  keys: z.object({
    /** The browser's P-256 public key, uncompressed (65 bytes). */
    p256dh: base64url(65, "keys.p256dh"),
    /** Shared authentication secret (16 bytes). */
    auth: base64url(16, "keys.auth"),
  }),
});
export type PushSubscriptionJson = z.infer<typeof PushSubscriptionSchema>;

/** A request about one subscribed device (check, unsubscribe). */
export const PushEndpointSchema = z.object({ endpoint: z.string().min(1).max(2048) });

/** "Send a test": to one device, or to every device when `endpoint` is left out. */
export const PushTestSchema = z.object({ endpoint: z.string().min(1).max(2048).optional() });

/** Validate a request body, with the issues as one readable line when it doesn't fit. */
export function parseBody<T>(schema: z.ZodType<T>, data: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(data);
  return result.success ? { ok: true, data: result.data } : { ok: false, error: result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") };
}
