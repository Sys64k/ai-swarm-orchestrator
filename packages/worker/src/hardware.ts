import os from "node:os";
import si from "systeminformation";
import type { HardwareProfile } from "@aso/shared";

/** Collect the hardware profile the Hub uses for capability-based task routing. */
export async function profileHardware(): Promise<HardwareProfile> {
  const [cpu, mem, osInfo, disks, docker] = await Promise.all([
    si.cpu(),
    si.mem(),
    si.osInfo(),
    si.diskLayout().catch(() => []),
    si.dockerInfo().catch(() => null),
  ]);

  return {
    hostname: os.hostname(),
    platform: osInfo.platform,
    distro: `${osInfo.distro} ${osInfo.release}`.trim(),
    cpu: { brand: cpu.brand, physicalCores: cpu.physicalCores, logicalCores: cpu.cores },
    memory: { totalBytes: mem.total, availableBytes: mem.available },
    disks: disks.map((d) => ({ name: d.name, type: d.type, sizeBytes: d.size })),
    // dockerInfo() resolves with empty fields when the daemon is unreachable.
    docker: docker?.serverVersion
      ? { available: true, version: docker.serverVersion }
      : { available: false },
  };
}
