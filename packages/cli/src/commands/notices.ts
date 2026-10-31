import { hubHttpBase, type Notice, type Notices } from "@aso/shared";
import { api } from "../hub-api.js";

export interface NoticesOptions {
  hub: string;
  limit: string;
  unread?: boolean;
  read?: boolean;
}

/** One notice as the CLI prints it: when, a mark for unread, the title, then its text and page indented. */
export function noticeLines(notice: Notice, unread: boolean): string[] {
  const when = notice.at.slice(0, 16).replace("T", " ");
  return [`${unread ? "●" : " "} ${when}  ${notice.title}`, ...notice.body.split("\n").map((line) => `    ${line}`), `    ${notice.url}`];
}

/** What `aso notices` prints: the unread count, then each notice (only the unread ones with `unreadOnly`). */
export function noticesText(list: Notices, unreadOnly = false): string {
  // Newest first, so the unread ones are the first `unread`.
  const shown = unreadOnly ? list.notices.slice(0, list.unread) : list.notices;
  if (!shown.length) return unreadOnly ? "no unread notices" : "no notices";
  return [`${list.unread} unread`, ...shown.flatMap((n, i) => ["", ...noticeLines(n, i < list.unread)])].join("\n");
}

export async function noticesCommand(opts: NoticesOptions): Promise<void> {
  const base = hubHttpBase(opts.hub);
  if (!/^\d+$/.test(opts.limit)) throw new Error("--limit takes a whole number");
  const list = await api<Notices>(base, `/api/notices?limit=${opts.limit}`);
  console.log(noticesText(list, opts.unread));
  if (opts.read && list.notices.length) {
    // Up to the newest shown, so anything that arrived meanwhile stays unread.
    await api(base, "/api/notices/read", { method: "POST", body: JSON.stringify({ upTo: list.notices[0].id }) });
    console.log("\nmarked read");
  }
}
