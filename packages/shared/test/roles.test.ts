import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ROLE_POLICIES, globToRegExp, orderPlan, writeDenial, type PlannedTask } from "@aso/shared";

describe("globs", () => {
  it("matches ** across directories and * within a segment", () => {
    const cases: Array<[string, string, boolean]> = [
      ["**/*.test.*", "a.test.ts", true],
      ["**/*.test.*", "src/deep/a.test.tsx", true],
      ["**/*.test.*", "src/a.ts", false],
      ["**/test/**", "test/a.js", true],
      ["**/test/**", "packages/x/test/a.js", true],
      ["**/test/**", "testing/a.js", false],
      [".github/**", ".github/workflows/ci.yml", true],
      [".github/**", "src/.github/x", false],
      ["**/Dockerfile", "Dockerfile", true],
      ["**/Dockerfile", "svc/api/Dockerfile", true],
      ["**/Dockerfile", "Dockerfile.dev", false],
      ["Makefile", "sub/Makefile", false],
    ];
    for (const [glob, p, expected] of cases) assert.equal(globToRegExp(glob).test(p), expected, `${glob} vs ${p}`);
  });
});

describe("role policies", () => {
  it("scopes QA to tests, DevOps to infra, Architect to nothing", () => {
    assert.equal(writeDenial("qa", "src/math.test.js"), undefined);
    assert.equal(writeDenial("qa", "apps/web/e2e/login.spec.ts"), undefined);
    assert.match(writeDenial("qa", "src/math.js")!, /may only modify test files/);
    assert.equal(writeDenial("devops", ".github/workflows/ci.yml"), undefined);
    assert.equal(writeDenial("devops", "services/api/Dockerfile"), undefined);
    assert.match(writeDenial("devops", "src/app.ts")!, /container, CI and deployment files/);
    assert.match(writeDenial("architect", "README.md")!, /read-only/);
    assert.equal(writeDenial("backend", "anything/at/all.ts"), undefined);
    assert.equal(writeDenial("frontend", "app/page.tsx"), undefined);
  });

  it("gives the Architect only exploration tools and submit_plan", () => {
    assert.deepEqual(ROLE_POLICIES.architect.tools, ["list_files", "read_file", "search", "submit_plan"]);
    for (const role of ["backend", "frontend", "qa", "devops"] as const) {
      assert.ok(ROLE_POLICIES[role].tools.includes("finish"));
      assert.ok(!ROLE_POLICIES[role].tools.includes("submit_plan"));
    }
  });
});

describe("orderPlan", () => {
  const t = (key: string, dependsOn: string[] = []): PlannedTask => ({
    key, role: "backend", kind: "feature", title: key, description: key, acceptanceCriteria: [], files: [], dependsOn,
  });

  it("puts dependencies first", () => {
    const ordered = orderPlan([t("page", ["api"]), t("api", ["schema"]), t("schema"), t("docs")]);
    assert.ok(Array.isArray(ordered));
    const keys = (ordered as PlannedTask[]).map((x) => x.key);
    assert.ok(keys.indexOf("schema") < keys.indexOf("api") && keys.indexOf("api") < keys.indexOf("page"));
    assert.equal(keys.length, 4);
  });

  it("rejects duplicates, unknown or self dependencies and cycles", () => {
    assert.match(orderPlan([t("a"), t("a")]) as string, /duplicate task key "a"/);
    assert.match(orderPlan([t("a", ["zzz"])]) as string, /unknown key "zzz"/);
    assert.match(orderPlan([t("a", ["a"])]) as string, /depends on itself/);
    assert.match(orderPlan([t("a", ["b"]), t("b", ["c"]), t("c", ["a"])]) as string, /dependency cycle/);
  });
});
