/** Default TCP port for the Hub API + WebSocket server. */
export const DEFAULT_HUB_PORT = 7420;

/** Default port for the Next.js dashboard. */
export const DEFAULT_DASHBOARD_PORT = 7421;

/** Path on the Hub that accepts agent WebSocket connections. */
export const WS_PATH = "/ws";

/** tmux session name used for the Architect agent. */
export const ARCHITECT_TMUX_SESSION = "aso-architect";

/** How often nodes send NODE_HEARTBEAT. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** The Hub drops nodes it has not heard from for this long. */
export const NODE_TIMEOUT_MS = 60_000;
