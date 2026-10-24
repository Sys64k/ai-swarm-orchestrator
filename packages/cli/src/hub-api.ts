import { authorizationHeader, resolveToken } from "@aso/shared";

/** A failed answer from the Hub, with its HTTP status. */
export class HubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Call the Hub's API with this machine's ASO token; throws with the Hub's own error message. */
export async function api<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const token = resolveToken()?.token;
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { authorization: authorizationHeader(token) } : {}) },
    });
  } catch {
    throw new Error(`cannot reach the Hub at ${base} (is it running? use --hub)`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401) throw new HubApiError("the Hub rejected the ASO token (set ASO_TOKEN; `aso token` on the Hub shows it)", 401);
  if (!res.ok) throw new HubApiError(body.error ?? `Hub returned HTTP ${res.status}`, res.status);
  return body;
}
