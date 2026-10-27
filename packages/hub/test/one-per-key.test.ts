import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OnePerKey } from "@aso/hub";

describe("one job per key", () => {
  it("joins a call for the same version, runs one for a newer version after it, and keeps keys apart", async () => {
    const jobs = new OnePerKey<string>();
    const ran: string[] = [];
    let release!: () => void;
    const first = jobs.run("task", "c1", () => new Promise<void>((r) => (release = () => (ran.push("c1"), r()))));
    const again = jobs.run("task", "c1", async () => void ran.push("c1 again"));
    const newer = jobs.run("task", "c2", async () => void ran.push("c2"));
    const other = jobs.run("other", "c1", async () => void ran.push("other"));
    await other;
    assert.deepEqual(ran, ["other"], "another key doesn't wait");
    release();
    await Promise.all([first, again, newer]);
    assert.deepEqual(ran, ["other", "c1", "c2"], "the same version ran once; the newer one after it");
    await jobs.run("task", "c1", async () => void ran.push("c1 later"));
    assert.equal(ran.at(-1), "c1 later", "once done, the same version can run again");
  });

  it("runs the next job even when the one before it failed", async () => {
    const jobs = new OnePerKey<string>();
    const failing = jobs.run("task", "c1", async () => {
      throw new Error("GitHub is down");
    });
    let ranNext = false;
    const next = jobs.run("task", "c2", async () => void (ranNext = true));
    await assert.rejects(failing, /GitHub is down/);
    await next;
    assert.equal(ranNext, true, "the newer version still ran");
  });
});
