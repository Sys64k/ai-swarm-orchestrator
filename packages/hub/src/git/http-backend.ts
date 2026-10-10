import { spawn } from "node:child_process";
import { gunzipSync } from "node:zlib";
import type { Context } from "hono";
import { GIT_PATH, TASK_REF_PATTERN, createLogger } from "@aso/shared";

const log = createLogger("git-http");

const ZERO_SHA = /^0+$/;
const ALLOWED_PATHS = /^\/(info\/refs|HEAD|git-upload-pack|git-receive-pack)$/;
/** Generous ceiling for a single push/fetch request body. */
const MAX_BODY_BYTES = 512 * 1024 * 1024;

export interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

/**
 * Parse the ref-update commands at the start of a git-receive-pack request:
 * pkt-lines of "<old> <new> <ref>[\0capabilities]" terminated by a flush packet.
 */
export function parseReceivePackCommands(body: Buffer): RefUpdate[] {
  const updates: RefUpdate[] = [];
  let pos = 0;
  while (pos + 4 <= body.length) {
    const len = parseInt(body.subarray(pos, pos + 4).toString("ascii"), 16);
    if (Number.isNaN(len)) throw new Error("malformed pkt-line");
    if (len === 0) return updates; // flush: commands done, packfile follows
    if (len < 4 || pos + len > body.length) throw new Error("truncated pkt-line");
    const line = body.subarray(pos + 4, pos + len).toString("utf8").split("\0")[0].trimEnd();
    pos += len;
    if (line.startsWith("shallow ")) continue;
    if (line.startsWith("push-cert")) throw new Error("signed pushes are not supported");
    const [oldSha, newSha, ref] = line.split(" ");
    if (!oldSha || !newSha || !ref) throw new Error(`malformed command: ${line}`);
    updates.push({ oldSha, newSha, ref });
  }
  throw new Error("missing flush packet");
}

/** Workers may only create or update `refs/heads/task/<id>`; never main, tags or deletions. */
export function checkPushPolicy(updates: RefUpdate[]): string | undefined {
  if (updates.length === 0) return "empty push";
  for (const u of updates) {
    if (!TASK_REF_PATTERN.test(u.ref)) return `pushing ${u.ref} is not allowed; only refs/heads/task/<id>`;
    if (ZERO_SHA.test(u.newSha)) return `deleting ${u.ref} is not allowed`;
  }
  return undefined;
}

/**
 * Git smart-HTTP for the Hub repository, implemented as a CGI bridge to `git http-backend`.
 * Mounted at GIT_PATH; workers clone/fetch/push `http://<hub>:<port>/git/project.git`.
 */
export function gitHttpHandler(repoDir: string) {
  return async (c: Context): Promise<Response> => {
    const pathInfo = c.req.path.slice(GIT_PATH.length);
    if (!ALLOWED_PATHS.test(pathInfo)) return c.text("not found", 404);

    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return c.text("request too large", 413);
    const body = c.req.method === "POST" ? Buffer.from(await c.req.arrayBuffer()) : Buffer.alloc(0);
    if (body.length > MAX_BODY_BYTES) return c.text("request too large", 413);

    if (pathInfo === "/git-receive-pack") {
      let updates: RefUpdate[];
      try {
        const raw = c.req.header("content-encoding") === "gzip" ? gunzipSync(body) : body;
        updates = parseReceivePackCommands(raw);
      } catch (err) {
        return c.text(`invalid push: ${(err as Error).message}`, 400);
      }
      const violation = checkPushPolicy(updates);
      if (violation) {
        log.warn(`rejected push: ${violation}`);
        return c.text(violation, 403);
      }
      log.info(`push ${updates.map((u) => `${u.ref} -> ${u.newSha.slice(0, 8)}`).join(", ")}`);
    }

    const url = new URL(c.req.url);
    const child = spawn("git", ["-c", "http.receivepack=true", "http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: repoDir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        REQUEST_METHOD: c.req.method,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: c.req.header("content-type") ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: c.req.header("content-encoding") ?? "",
        GIT_PROTOCOL: c.req.header("git-protocol") ?? "",
        REMOTE_ADDR: c.req.header("x-forwarded-for") ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", (d: Buffer) => log.debug(d.toString().trim()));
    child.stdin.on("error", () => undefined); // backend may exit before reading everything
    child.stdin.end(body);

    return cgiResponse(child.stdout, new Promise((resolve) => child.on("error", resolve)));
  };
}

/** Split CGI output into status/headers and a streamed body. */
function cgiResponse(stdout: NodeJS.ReadableStream, spawnError: Promise<unknown>): Promise<Response> {
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    let resolved = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });

    void spawnError.then((err) => {
      if (!resolved) {
        resolved = true;
        resolve(new Response(`git http-backend failed: ${String(err)}`, { status: 500 }));
      }
    });

    stdout.on("data", (chunk: Buffer) => {
      if (resolved) return controller.enqueue(new Uint8Array(chunk));
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf("\r\n\r\n");
      const alt = head.indexOf("\n\n");
      const [end, sepLen] = sep >= 0 ? [sep, 4] : alt >= 0 ? [alt, 2] : [-1, 0];
      if (end < 0) return;

      const headers = new Headers();
      let status = 200;
      for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") status = parseInt(value, 10) || 200;
        else headers.append(name, value);
      }
      const rest = head.subarray(end + sepLen);
      if (rest.length) controller.enqueue(new Uint8Array(rest));
      resolved = true;
      resolve(new Response(stream, { status, headers }));
    });
    stdout.on("end", () => {
      if (!resolved) {
        resolved = true;
        resolve(new Response("git http-backend produced no response", { status: 502 }));
      } else controller.close();
    });
  });
}
