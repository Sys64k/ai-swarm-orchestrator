import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectNode, type NodeSnapshot, type RoutingDecision } from "@aso/hub";
import type { HardwareProfile } from "@aso/shared";

const GiB = 1024 ** 3;

function node(
  nodeId: string,
  opts: {
    ramGiB?: number;
    freeGiB?: number;
    cores?: number;
    mbps?: number;
    docker?: boolean;
    busy?: boolean;
    load?: number;
    lastAssignedAt?: number;
  } = {},
): NodeSnapshot {
  const ram = (opts.ramGiB ?? 16) * GiB;
  const hardware: HardwareProfile = {
    hostname: nodeId,
    platform: "linux",
    distro: "Ubuntu",
    cpu: { brand: "cpu", physicalCores: opts.cores ?? 8, logicalCores: opts.cores ?? 8 },
    memory: { totalBytes: ram, availableBytes: (opts.freeGiB ?? opts.ramGiB ?? 16) * GiB },
    disks: [],
    docker: { available: opts.docker ?? false },
    storage: { workDir: "/w", writeMBps: opts.mbps ?? 500 },
  };
  return {
    nodeId,
    hardware,
    busy: opts.busy ?? false,
    lastAssignedAt: opts.lastAssignedAt,
    load:
      opts.load === undefined
        ? undefined
        : { memoryAvailableBytes: hardware.memory.availableBytes, cpuLoadPercent: opts.load, dockerAvailable: opts.docker ?? false },
  };
}

function chosen(d: RoutingDecision): string {
  assert.ok(d.ok, d.ok ? "" : `expected a node, got: ${d.reason}`);
  return d.nodeId;
}

describe("selectNode", () => {
  it("sends e2e tests to the node with the most free RAM", () => {
    const nodes = [node("small", { ramGiB: 8 }), node("big", { ramGiB: 64, cores: 4 }), node("mid", { ramGiB: 32 })];
    assert.equal(chosen(selectNode({ role: "qa", kind: "e2e_test" }, nodes)), "big");
  });

  it("keeps e2e tests off nodes below the RAM minimum", () => {
    const d = selectNode({ role: "qa", kind: "e2e_test" }, [node("pi", { ramGiB: 2 })]);
    assert.ok(!d.ok);
    assert.match(d.rejected[0].reason, /below 4.0 GiB minimum/);
  });

  it("sends database migrations to the fastest disk", () => {
    const nodes = [node("hdd", { mbps: 120, ramGiB: 64 }), node("nvme", { mbps: 2500, ramGiB: 8 })];
    const d = selectNode({ role: "backend", kind: "db_migration" }, nodes);
    assert.equal(chosen(d), "nvme");
    assert.ok(d.ok && d.reasons.some((r) => r.includes("2500 MB/s")));
  });

  it("only sends container builds to Docker hosts, even if weaker", () => {
    const nodes = [node("beefy", { cores: 32, ramGiB: 128 }), node("docker", { cores: 2, ramGiB: 4, docker: true })];
    assert.equal(chosen(selectNode({ role: "devops", kind: "container_build" }, nodes)), "docker");
  });

  it("uses live heartbeat docker status over the registration snapshot", () => {
    const n = node("d", { docker: true, load: 0 });
    n.load!.dockerAvailable = false;
    const d = selectNode({ role: "devops", kind: "container_build" }, [n]);
    assert.ok(!d.ok && d.rejected[0].reason === "no Docker daemon");
  });

  it("skips busy nodes and gives any free node any role, explaining every rejection", () => {
    const nodes = [node("busy", { busy: true }), node("ok")];
    for (const role of ["backend", "frontend", "qa", "devops"] as const) {
      assert.equal(chosen(selectNode({ role, kind: "feature" }, nodes)), "ok", role);
    }

    const none = selectNode({ role: "backend", kind: "feature" }, nodes.slice(0, 1));
    assert.ok(!none.ok);
    assert.deepEqual(none.rejected, [{ nodeId: "busy", reason: "busy" }]);
  });

  it("discounts CPU cores by current load", () => {
    const nodes = [node("loaded", { cores: 16, load: 90 }), node("quiet", { cores: 8, load: 0 })];
    assert.equal(chosen(selectNode({ role: "backend", kind: "feature" }, nodes)), "quiet");
  });

  it("breaks ties in favour of the node idle the longest", () => {
    const nodes = [node("recent", { lastAssignedAt: 2000 }), node("never"), node("older", { lastAssignedAt: 1000 })];
    assert.equal(chosen(selectNode({ role: "backend", kind: "feature" }, nodes)), "never");
    assert.equal(chosen(selectNode({ role: "backend", kind: "feature" }, [nodes[0], nodes[2]])), "older");
  });

  it("reports when no workers are connected", () => {
    const d = selectNode({ role: "backend", kind: "feature" }, []);
    assert.ok(!d.ok && d.reason === "no worker nodes connected");
  });
});
