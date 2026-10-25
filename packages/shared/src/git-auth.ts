import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A git config string: quoted, so its characters can't change what the file says. */
function quote(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("a Git credential contains a control character");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Git config that sends `header` (e.g. `Authorization: Bearer ...`) with HTTP requests: to
 * every remote, or only to URLs under `scope` (e.g. `https://github.com/`).
 */
export function gitHeaderConfigText(header: string, scope?: string): string {
  const section = scope === undefined ? "[http]" : `[http ${quote(scope)}]`;
  return `${section}\n\textraHeader = ${quote(header)}\n`;
}

let dir: string | undefined;
const files = new Map<string, string>();

/**
 * An owner-only file holding `gitHeaderConfigText(header, scope)`, for
 * `git -c include.path=<file>`: unlike `-c http.extraHeader=...`, it keeps the credential out of
 * the process list. One file per header and scope, in a private folder removed when the process
 * exits.
 */
export function gitHeaderConfigFile(header: string, scope?: string): string {
  const text = gitHeaderConfigText(header, scope);
  const known = files.get(text);
  if (known) return known;
  if (!dir) {
    dir = mkdtempSync(path.join(os.tmpdir(), "aso-git-auth-"));
    const made = dir;
    process.once("exit", () => rmSync(made, { recursive: true, force: true }));
  }
  const file = path.join(dir, `${files.size}.gitconfig`);
  writeFileSync(file, text, { mode: 0o600, flag: "wx" });
  files.set(text, file);
  return file;
}

/**
 * The config entry (`include.path=<file>`, for `git -c`) that sends `x-access-token:<token>` as
 * Basic auth to `url`'s host only; undefined for a remote that isn't HTTP(S).
 */
export function gitBasicAuthConfig(url: string, token: string): string | undefined {
  if (!/^https?:\/\//.test(url)) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `include.path=${gitHeaderConfigFile(`Authorization: Basic ${basic}`, `${new URL(url).origin}/`)}`;
}
