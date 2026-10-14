import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SignInCodes } from "@aso/hub";
import { TOKEN, withHub } from "./helpers.ts";

describe("sign-in codes", () => {
  it("work once, and only before they expire", () => {
    const codes = new SignInCodes(1000);
    const { code, expiresAt } = codes.create(0);
    assert.match(code, /^[A-Za-z0-9_-]{24}$/);
    assert.equal(expiresAt, new Date(1000).toISOString());
    assert.equal(codes.redeem(code, 500), true);
    assert.equal(codes.redeem(code, 500), false, "single use");

    const late = codes.create(0).code;
    assert.equal(codes.redeem(late, 1000), false, "expired");
    assert.equal(codes.redeem("made-up", 0), false);
    assert.equal(codes.redeem(undefined, 0), false);
  });

  it("keeps at most 20 outstanding codes, dropping the oldest", () => {
    const codes = new SignInCodes();
    const first = codes.create().code;
    for (let i = 0; i < 20; i++) codes.create();
    assert.equal(codes.redeem(first), false);
  });

  it("are created and redeemed over the API, only with the token", () =>
    withHub(async (ctx) => {
      const call = (path: string, body?: unknown, token: string | null = TOKEN) =>
        fetch(`http://127.0.0.1:${ctx.port}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      assert.equal((await call("/api/sign-in-codes", undefined, null)).status, 401);
      assert.equal((await call("/api/sign-in-codes/redeem", { code: "x" }, null)).status, 401);

      const created = await call("/api/sign-in-codes");
      assert.equal(created.status, 201);
      const { code } = (await created.json()) as { code: string };
      assert.equal((await call("/api/sign-in-codes/redeem", { code })).status, 200);
      const again = await call("/api/sign-in-codes/redeem", { code });
      assert.equal(again.status, 410);
      assert.match(((await again.json()) as { error: string }).error, /used up or expired/);
    }));
});
