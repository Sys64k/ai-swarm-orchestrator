import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, it } from "node:test";
import { DockerCleanup, oldProjectImages, projectIds } from "../dist/docker-cleanup.js";

const at = (day: number) => `2026-10-${String(day).padStart(2, "0")} 12:00:00 +0000 UTC`;

describe("Docker cleanup", () => {
  it("keeps a project's three newest images and the one in use, and leaves other repositories alone", () => {
    const images = [
      ...[20, 21, 22, 23, 24, 25].map((d) => ({ repository: "aso-ui", tag: `c${d}`, createdAt: at(d) })),
      { repository: "aso-ui", tag: "<none>", createdAt: at(1) },
      { repository: "postgres", tag: "16-alpine", createdAt: at(1) },
      { repository: "someone-elses", tag: "old", createdAt: at(1) },
    ];
    const old = oldProjectImages(images, new Set(["aso-ui", "aso-test"]), new Set(["aso-ui:c21"]));
    assert.deepEqual(old.sort(), ["aso-ui:c20", "aso-ui:c22"], "c25, c24, c23 kept as the newest; c21 is running");
  });

  it("prunes old cache, dangling and old project images, at most once an hour, and never throws", async () => {
    const calls: string[] = [];
    let now = 0;
    const docker = async (args: string[]) => {
      calls.push(args.join(" "));
      if (args[0] === "ps") return "aso-ui:c25\npostgres:16-alpine\n";
      if (args[0] === "images") return [21, 22, 23, 24, 25].map((d) => `aso-ui\tc${d}\t${at(d)}`).join("\n") + "\n";
      return "";
    };
    const cleanup = new DockerCleanup(() => new Set(["aso-ui"]), docker, () => now);
    await cleanup.maybeRun("a deploy");
    assert.deepEqual(calls, [
      "builder prune -f --filter until=24h",
      "ps -a --format {{.Image}}",
      "images --format {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}",
      "rmi aso-ui:c22 aso-ui:c21",
      "image prune -f",
    ]);
    now += 30 * 60_000;
    await cleanup.maybeRun("another deploy");
    assert.equal(calls.length, 5, "not again within the hour");
    now += 31 * 60_000;
    const failing = new DockerCleanup(() => new Set(), async () => Promise.reject(new Error("docker: not found")), () => now);
    await failing.maybeRun("a deploy"); // logged, not thrown
  });

  it("knows the projects: the root's folders that are git repositories", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "aso-root-"));
    mkdirSync(path.join(root, "aso-ui", ".git"), { recursive: true });
    mkdirSync(path.join(root, "notes"));
    assert.deepEqual([...projectIds(root)], ["aso-ui"]);
    assert.deepEqual([...projectIds(path.join(root, "missing"))], []);
  });
});
