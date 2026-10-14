"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hubGet, hubPost } from "./hub-client.ts";

export interface Poll<T> {
  data: T | undefined;
  error: string | undefined;
  refresh: () => void;
}

/** Fetch a Hub `path` now and every `intervalMs` while the page is visible (phones: saves battery). */
export function usePoll<T>(path: string, intervalMs = 3000): Poll<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const inflight = useRef(false);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    const result = await hubGet<T>(path);
    inflight.current = false;
    if (result.ok) {
      setData(result.data);
      setError(undefined);
    } else {
      setError(result.error);
    }
  }, [path]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, intervalMs]);

  return { data, error, refresh: () => void load() };
}

/** POST to the Hub; resolves with the error message, if any (for ActionButton). */
export async function hubAction(path: string, body?: unknown): Promise<string | undefined> {
  const result = await hubPost(path, body);
  return result.ok ? undefined : result.error;
}
