import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Git config that sends `token` as a Bearer header to the Hub. A quoted value, so the token's
 * characters can't change what the file says; a token with a line break or other control
 * character is refused outright.
 */
export function authConfigText(token: string): string {
  if (/[\u0000-\u001f\u007f]/.test(token)) throw new Error("the ASO token contains a control character");
  const value = `Authorization: Bearer ${token}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[http]\n\textraHeader = "${value}"\n`;
}

let dir: string | undefined;
const files = new Map<string, string>();

/**
 * An owner-only file holding `authConfigText(token)`, for `git -c include.path=<file>`: unlike
 * `-c http.extraHeader=...`, it keeps the token out of the process list. One file per token, in
 * a private folder removed when the process exits.
 */
export function authConfigFile(token: string): string {
  const known = files.get(token);
  if (known) return known;
  if (!dir) {
    dir = mkdtempSync(path.join(os.tmpdir(), "aso-git-auth-"));
    const made = dir;
    process.once("exit", () => rmSync(made, { recursive: true, force: true }));
  }
  const file = path.join(dir, `${files.size}.gitconfig`);
  writeFileSync(file, authConfigText(token), { mode: 0o600, flag: "wx" });
  files.set(token, file);
  return file;
}
