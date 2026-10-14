"use client";

import { errorMessage } from "../lib/hub-routes.ts";

export type HubResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** GET a Hub endpoint through the console's proxy. */
export function hubGet<T>(path: string): Promise<HubResult<T>> {
  return request<T>(path, { cache: "no-store" });
}

/** POST to a Hub endpoint through the console's proxy. */
export function hubPost<T>(path: string, body?: unknown): Promise<HubResult<T>> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** An expired session sends the browser to the sign-in page, whichever request noticed it. */
async function request<T>(path: string, init: RequestInit): Promise<HubResult<T>> {
  try {
    const res = await fetch(`/api/hub/${path}`, init);
    if (res.status === 401) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
      return { ok: false, error: "signed out" };
    }
    const data = (await res.json().catch(() => null)) as unknown;
    return res.ok ? { ok: true, data: data as T } : { ok: false, error: errorMessage(res.status, data) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
