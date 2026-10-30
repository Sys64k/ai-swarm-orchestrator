"use client";

import { useSyncExternalStore } from "react";

/** The width from which pages put their sections side by side: the same as the media query in globals.css. */
const WIDE_QUERY = "(min-width: 1200px)";

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the screen is wide enough for columns; false while rendering on the server. */
export function useWide(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}
