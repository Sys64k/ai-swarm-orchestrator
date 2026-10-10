type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.ASO_LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LEVELS[env] ?? LEVELS.info;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
}

export function createLogger(scope: string): Logger {
  const emit = (level: Level, msg: string, meta?: unknown) => {
    if (LEVELS[level] < threshold()) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    const out = level === "error" || level === "warn" ? console.error : console.log;
    meta === undefined ? out(line) : out(line, meta);
  };
  return {
    debug: (m, x) => emit("debug", m, x),
    info: (m, x) => emit("info", m, x),
    warn: (m, x) => emit("warn", m, x),
    error: (m, x) => emit("error", m, x),
  };
}
