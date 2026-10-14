/** Default TCP port for the Hub API + WebSocket server. */
export const DEFAULT_HUB_PORT = 7420;

/** Default port for the Next.js dashboard. */
export const DEFAULT_DASHBOARD_PORT = 7421;

/** Path on the Hub that accepts agent WebSocket connections. */
export const WS_PATH = "/ws";

/** Prefix of the Hub's Git smart-HTTP endpoints: each project is served at `/git/<project>.git`. */
export const GIT_PATH = "/git";

/** Folder the Hub keeps its projects in, under the home directory, unless `--root` says otherwise. */
export const DEFAULT_PROJECTS_DIR = "aso-projects";

/** tmux session name used for the Architect agent. */
export const ARCHITECT_TMUX_SESSION = "aso-architect";

/** How often nodes send NODE_HEARTBEAT. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** The Hub drops nodes it has not heard from for this long. */
export const NODE_TIMEOUT_MS = 60_000;
