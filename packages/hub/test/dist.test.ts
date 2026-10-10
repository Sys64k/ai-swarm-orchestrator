import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { tempDir, withHub } from "./helpers.ts";

describe("package distribution", () => {
  it("serves the aso package publicly with version and checksum", () => {
    const dir = tempDir("aso-dist-");
    const file = path.join(dir, "aso.tgz");
    writeFileSync(file, "fake package bytes");
    const sha = createHash("sha256").update("fake package bytes").digest("hex");
    return withHub(
      async (ctx) => {
        const base = `http://127.0.0.1:${ctx.port}`;
        assert.deepEqual(await (await fetch(`${base}/api/version`)).json(), { version: "1.2.3+abc", package: true, sha256: sha });
        const res = await fetch(`${base}/dist/aso.tgz`);
        assert.equal(res.status, 200, "no token needed: new machines download it before they have one");
        assert.equal(await res.text(), "fake package bytes");
      },
      { dist: { version: () => "1.2.3+abc", tarball: () => file } },
    ).finally(() => rmSync(dir, { recursive: true, force: true }));
  });

  it("reports when there is nothing to serve", () =>
    withHub(async (ctx) => {
      const base = `http://127.0.0.1:${ctx.port}`;
      assert.deepEqual(await (await fetch(`${base}/api/version`)).json(), { version: null, package: false, sha256: null });
      assert.equal((await fetch(`${base}/dist/aso.tgz`)).status, 404);
    }));
});
