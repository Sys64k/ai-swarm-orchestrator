import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { startArchitect } from "@aso/architect";
import { isOutdated } from "@aso/hub";
import { startWorker } from "@aso/worker";
import { hardware, tempDir, TOKEN, waitFor, withHub } from "./helpers.ts";

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

  it("flags workers and Architects that run another build than the Hub serves", () => {
    const dir = tempDir("aso-dist-");
    const file = path.join(dir, "aso.tgz");
    writeFileSync(file, "pkg");
    return withHub(
      async (ctx) => {
        const hub = `127.0.0.1:${ctx.port}`;
        const common = { hub, token: TOKEN, roles: ["backend" as const], hardware: hardware(), sandbox: "none" as const };
        const current = await startWorker({ ...common, nodeId: "current", workDir: path.join(dir, "w1"), version: "1.2.3+abc" });
        const old = await startWorker({ ...common, nodeId: "old", workDir: path.join(dir, "w2"), version: "1.2.3+0ld" });
        const arch = startArchitect({ hub, token: TOKEN, nodeId: "arch", workDir: path.join(dir, "a"), version: "1.2.3+abc" });
        try {
          const nodes = await waitFor(async () => {
            const list = (await (await fetch(`http://${hub}/api/nodes`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as Array<{ nodeId: string; version: string; outdated: boolean }>;
            return list.length === 3 ? list : undefined;
          });
          const byId = Object.fromEntries(nodes.map((n) => [n.nodeId, n]));
          assert.deepEqual([byId.current.version, byId.current.outdated], ["1.2.3+abc", false]);
          assert.deepEqual([byId.old.version, byId.old.outdated], ["1.2.3+0ld", true]);
          assert.deepEqual([byId.arch.version, byId.arch.outdated], ["1.2.3+abc", false]);
        } finally {
          current.stop();
          old.stop();
          arch.stop();
        }
      },
      { dist: { version: () => "1.2.3+abc", tarball: () => file } },
    ).finally(() => rmSync(dir, { recursive: true, force: true }));
  });

  it("only calls a build outdated when it has one to compare with", () => {
    assert.equal(isOutdated("0.1.0", "0.1.0+abc"), true, "workers from before builds were reported");
    assert.equal(isOutdated("0.1.0+abc", "0.1.0+abc"), false);
    assert.equal(isOutdated("0.1.0+abc", undefined), false, "a Hub without a package can't tell");
  });
});
