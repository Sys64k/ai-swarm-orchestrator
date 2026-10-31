import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noticeLines, noticesText } from "../dist/commands/notices.js";

const notice = (id: string, title: string, body = "b") => ({ id, at: `2026-10-31T09:0${id}:30.000Z`, title, body, url: `/tasks/${id}`, tag: `task-${id}` });

describe("aso notices", () => {
  it("prints each notice with a mark when unread, its text and its page", () => {
    assert.deepEqual(noticeLines(notice("1", "shop: task failed", "API\nnpm test failed"), true), [
      "● 2026-10-31 09:01  shop: task failed",
      "    API",
      "    npm test failed",
      "    /tasks/1",
    ]);
    assert.equal(noticeLines(notice("1", "t"), false)[0], "  2026-10-31 09:01  t");
  });

  it("lists the newest first, the unread ones marked, or only those", () => {
    const list = { notices: [notice("3", "c"), notice("2", "b"), notice("1", "a")], unread: 1 };
    const all = noticesText(list);
    assert.match(all, /^1 unread\n/);
    assert.match(all, /● 2026-10-31 09:03 {2}c/);
    assert.match(all, / {2}2026-10-31 09:02 {2}b/);
    const unread = noticesText(list, true);
    assert.ok(unread.includes("c") && !unread.includes("09:02"));
    assert.equal(noticesText({ notices: [], unread: 0 }), "no notices");
    assert.equal(noticesText({ notices: list.notices, unread: 0 }, true), "no unread notices");
  });
});
