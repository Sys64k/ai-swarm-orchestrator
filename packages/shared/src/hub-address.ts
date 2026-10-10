import { DEFAULT_HUB_PORT, GIT_PATH, WS_PATH } from "./constants.js";

/**
 * Normalise a user-supplied hub address into a WebSocket URL.
 * Accepts `192.168.1.10`, `192.168.1.10:7420`, `hub.lan`, or a full `ws://` / `wss://` URL.
 */
export function resolveHubUrl(input: string, defaultPort = DEFAULT_HUB_PORT): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Hub address must not be empty");

  const withScheme = /^wss?:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid hub address: "${input}"`);
  }
  if (!url.port) url.port = String(defaultPort);
  if (url.pathname === "/" || url.pathname === "") url.pathname = WS_PATH;
  return url;
}

/** The Hub's Git endpoint, derived from its WebSocket URL (same host and port). */
export function hubGitUrl(wsUrl: URL): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = GIT_PATH;
  url.search = "";
  return url.href;
}
