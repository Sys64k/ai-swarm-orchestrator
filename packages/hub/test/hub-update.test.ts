import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hubUpdateNotification } from "@aso/hub";
import { TOKEN, withHub } from "./helpers.ts";

describe("the Hub's own update", () => {
  it("notifies when an update ends, once", () => {
    const building = { state: "building" as const, current: "0.1.0+aaaaaaa", target: "b".repeat(40) };
    assert.equal(hubUpdateNotification({ state: "off", current: "0.1.0+aaaaaaa" }, building), undefined, "steps on the way say nothing");
    const updated = { state: "updated" as const, current: "0.1.0+bbbbbbb", target: "b".repeat(40) };
    assert.deepEqual(hubUpdateNotification(building, updated), { title: "Hub updated", body: "Now running 0.1.0+bbbbbbb.", url: "/", tag: "hub-update" });
    assert.equal(hubUpdateNotification(updated, { ...updated }), undefined, "the same outcome again");
    const failed = { state: "failed" as const, current: "0.1.0+aaaaaaa", target: "c".repeat(40), error: "build or tests failed" };
    assert.equal(hubUpdateNotification(building, failed)?.body, "Update to ccccccc failed: build or tests failed. Still running 0.1.0+aaaaaaa.");
  });

  it("keeps what the updater reports, and rejects a bad report", () =>
    withHub(async (ctx) => {
      const call = (method: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${ctx.port}/api/hub/update`, {
          method,
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));
      assert.equal((await call("GET")).body.state, "off");
      assert.equal((await call("POST", { state: "off" })).status, 400, "only the Hub says off");
      assert.equal((await call("POST", { state: "waiting", extra: 1 })).status, 400);
      assert.equal((await call("POST", { state: "waiting", current: "0.1.0+fake" })).status, 400, "the Hub says what it runs");
      const ok = await call("POST", { state: "waiting", target: "b".repeat(40) });
      assert.equal(ok.status, 200);
      const now = (await call("GET")).body;
      assert.equal(now.state, "waiting");
      assert.equal(now.current, "0.1.0+test");
      assert.match(now.at, /^\d{4}-\d\d-\d\dT/);
      assert.equal((await fetch(`http://127.0.0.1:${ctx.port}/api/hub/update`)).status, 401);
    }, { dist: { version: () => "0.1.0+test", tarball: () => undefined } }));
});
