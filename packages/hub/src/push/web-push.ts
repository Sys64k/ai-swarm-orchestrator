import { createECDH, createCipheriv, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type webcrypto } from "node:crypto";
import type { PushSubscriptionJson } from "@aso/shared";

/**
 * Web Push without a push library: payload encryption per RFC 8291 (aes128gcm, RFC 8188) and
 * VAPID authentication per RFC 8292, with node:crypto only. The push service (FCM for Chrome on
 * Android, Mozilla's for Firefox) only ever sees the encrypted payload.
 */

/** The Hub's application server key pair; the public half is what browsers subscribe with. */
export interface VapidKeys {
  /** Uncompressed P-256 point, URL-safe base64 (65 bytes): `applicationServerKey` for browsers. */
  publicKey: string;
  privateKey: webcrypto.JsonWebKey;
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  return { publicKey: rawPublicKey(jwk).toString("base64url"), privateKey: jwk };
}

function rawPublicKey(jwk: webcrypto.JsonWebKey): Buffer {
  return Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
}

/** `Authorization` header value for a push to `endpoint` (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const json = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${json({ typ: "JWT", alg: "ES256" })}.${json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_TOKEN_TTL_SEC,
    sub: subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey({ key: keys.privateKey, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${keys.publicKey}`;
}

/** How long a VAPID token is valid (push services accept at most 24 h). */
const VAPID_TOKEN_TTL_SEC = 12 * 3600;
/** How long the push service keeps a message for a device that is offline. */
const DEFAULT_MESSAGE_TTL_SEC = 24 * 3600;
const PUSH_TIMEOUT_MS = 15_000;

/** Record size advertised in the header; the whole payload fits in one record. */
const RECORD_SIZE = 4096;
/** Push services accept 4096 bytes of body; header (86) + tag (16) + delimiter (1) leave this. */
export const MAX_PAYLOAD_BYTES = RECORD_SIZE - 86 - 16 - 1;

/** Encrypt `payload` for one subscription (RFC 8291, single aes128gcm record). */
export function encryptPayload(
  payload: Buffer,
  sub: PushSubscriptionJson,
  testing?: { serverKeys?: ReturnType<typeof createECDH>; salt?: Buffer },
): Buffer {
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error(`push payload is ${payload.length} bytes (max ${MAX_PAYLOAD_BYTES})`);
  const uaPublic = Buffer.from(sub.keys.p256dh, "base64url");
  const authSecret = Buffer.from(sub.keys.auth, "base64url");
  const server = testing?.serverKeys ?? createECDH("prime256v1");
  if (!testing?.serverKeys) server.generateKeys();
  const asPublic = server.getPublicKey();
  const ecdhSecret = server.computeSecret(uaPublic);
  const salt = testing?.salt ?? randomBytes(16);

  const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (only) record, with no padding after it.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export type PushResult = { ok: true } | { ok: false; status?: number; error: string; gone: boolean };

/** Deliver one push message. `gone` means the subscription no longer exists and should be dropped. */
export async function sendPush(
  sub: PushSubscriptionJson,
  /** JSON-serialisable; the console's service worker reads `title`, `body`, `url` and `tag`. */
  payload: object,
  keys: VapidKeys,
  opts: { subject: string; ttlSec?: number; urgency?: "normal" | "high"; fetch?: typeof fetch },
): Promise<PushResult> {
  let body: Buffer;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub);
  } catch (err) {
    return { ok: false, error: (err as Error).message, gone: false };
  }
  try {
    const res = await (opts.fetch ?? fetch)(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthorization(sub.endpoint, keys, opts.subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(opts.ttlSec ?? DEFAULT_MESSAGE_TTL_SEC),
        urgency: opts.urgency ?? "high",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    const text = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, status: res.status, error: `push service answered ${res.status}${text ? `: ${text}` : ""}`, gone: res.status === 404 || res.status === 410 };
  } catch (err) {
    return { ok: false, error: (err as Error).message, gone: false };
  }
}
