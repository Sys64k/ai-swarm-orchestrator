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

/** What a node reports when it doesn't know its aso build (always shown as outdated). */
export const UNKNOWN_VERSION = "unknown";

/** Largest WebSocket frame the Hub accepts; larger frames are rejected before parsing. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Base64 characters of images one turn's tool results may carry. With the text results'
 * own budget (about 1.2 MB) the turn stays well under MAX_FRAME_BYTES.
 */
export const TURN_IMAGE_BUDGET = 5_500_000;

/** Largest image file `view_image` sends to the model (raw bytes; base64 adds a third). */
export const IMAGE_MAX_BYTES = 2_000_000;

/** Longest image side the model accepts, in pixels. */
export const IMAGE_MAX_SIDE = 8000;

/** Image types `view_image` accepts, as the Messages API names them. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/**
 * Images one agent conversation may hold. Every image stays in the history and is sent again
 * with each turn, so these keep a request well under the API's 32 MB limit.
 */
export const CONVERSATION_MAX_IMAGES = 20;
export const CONVERSATION_MAX_IMAGE_BYTES = 12_000_000;

/**
 * QA screenshots: a project opts in with an npm script of this name. After the tests pass, the
 * QA worker runs it with SCREENSHOT_DIR_ENV set to an empty folder; the images the script saves
 * there go to the Hub with the verdict, so a reviewer sees them next to the diff.
 */
export const SCREENSHOT_SCRIPT = "screenshots";
export const SCREENSHOT_DIR_ENV = "ASO_SCREENSHOT_DIR";
/** At most this many screenshots per QA run, together at most QA_SCREENSHOTS_MAX_BYTES (raw). */
export const QA_SCREENSHOTS_MAX = 12;
export const QA_SCREENSHOTS_MAX_BYTES = 4_000_000;
