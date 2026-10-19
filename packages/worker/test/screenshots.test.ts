import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { IMAGE_MAX_BYTES, QA_SCREENSHOTS_MAX, QA_SCREENSHOTS_MAX_BYTES } from "@aso/shared";
import { collectScreenshots, hasScreenshotScript, missingViews } from "@aso/worker";

let dir: string;
beforeEach(() => (dir = mkdtempSync(path.join(os.tmpdir(), "aso-shots-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A PNG header padded to `size` bytes: all the collector reads is the header. */
function png(size = 33): Buffer {
  const b = Buffer.alloc(size);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(10, 16);
  b.writeUInt32BE(10, 20);
  return b;
}

describe("QA screenshots (worker)", () => {
  it("finds the screenshots script in package.json", async () => {
    assert.equal(await hasScreenshotScript(dir), false, "no package.json");
    writeFileSync(path.join(dir, "package.json"), "{ not json");
    assert.equal(await hasScreenshotScript(dir), false);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "x" } }));
    assert.equal(await hasScreenshotScript(dir), false);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { screenshots: "playwright test e2e/screens.spec.ts" } }));
    assert.equal(await hasScreenshotScript(dir), true);
  });

  it("collects images in name order and says what it left out", async () => {
    writeFileSync(path.join(dir, "b-dark.png"), png());
    writeFileSync(path.join(dir, "a-light.png"), png());
    writeFileSync(path.join(dir, "trace.zip"), "PK");
    writeFileSync(path.join(dir, ".hidden.png"), png());
    writeFileSync(path.join(dir, "huge.png"), png(IMAGE_MAX_BYTES + 1));
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(path.join(dir, "nested", "c.png"), png());
    const { screenshots, skipped } = await collectScreenshots(dir);
    assert.deepEqual(screenshots.map((s) => [s.name, s.mediaType]), [["a-light.png", "image/png"], ["b-dark.png", "image/png"]]);
    assert.equal(screenshots[0].data, png().toString("base64"));
    assert.deepEqual(skipped, [
      ".hidden.png (name not allowed: letters, digits and ._- only)",
      "huge.png (over 2 MB)",
      "trace.zip (not a PNG, JPEG, GIF or WebP image)",
    ]);
  });

  it("keeps to the count and total size limits", async () => {
    for (let i = 0; i < QA_SCREENSHOTS_MAX + 2; i++) writeFileSync(path.join(dir, `s${String(i).padStart(2, "0")}.png`), png());
    const many = await collectScreenshots(dir);
    assert.equal(many.screenshots.length, QA_SCREENSHOTS_MAX);
    assert.deepEqual(many.skipped, [`s12.png (over ${QA_SCREENSHOTS_MAX} screenshots)`, `s13.png (over ${QA_SCREENSHOTS_MAX} screenshots)`]);

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    const big = Math.floor(QA_SCREENSHOTS_MAX_BYTES / 3);
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) writeFileSync(path.join(dir, name), png(big));
    const heavy = await collectScreenshots(dir);
    assert.deepEqual(heavy.screenshots.map((s) => s.name), ["a.png", "b.png", "c.png"]);
    assert.deepEqual(heavy.skipped, ["d.png (over 4 MB together)"]);
  });

  it("returns nothing for a missing folder", async () => {
    assert.deepEqual(await collectScreenshots(path.join(dir, "missing")), { screenshots: [], skipped: [] });
  });
});

describe("missingViews", () => {
  const view = (name: string) => ({ name, path: "/" });

  it("names the listed views without a saved <name>.png, in list order", () => {
    const saved = [{ name: "review-dark.png" }, { name: "extra.png" }];
    assert.deepEqual(missingViews([view("running-light"), view("review-dark"), view("running-dark")], saved), ["running-light", "running-dark"]);
  });

  it("is empty when every view was saved or none were listed", () => {
    assert.deepEqual(missingViews([view("a")], [{ name: "a.png" }]), []);
    assert.deepEqual(missingViews(undefined, [{ name: "a.png" }]), []);
  });

  it("does not count an image of another type as the view", () => {
    assert.deepEqual(missingViews([view("a")], [{ name: "a.jpg" }]), ["a"]);
  });
});
