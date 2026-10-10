export const dynamic = "force-dynamic";

const HUB = `http://127.0.0.1:${process.env.ASO_HUB_PORT ?? "7420"}`;
const GiB = 1024 ** 3;

interface Health {
  status: string;
  targetDir: string;
  connections: number;
  uptimeSec: number;
}

interface NodeView {
  nodeId: string;
  nodeKind: "worker" | "architect";
  roles?: string[];
  hardware?: {
    hostname: string;
    distro: string;
    cpu: { logicalCores: number };
    memory: { totalBytes: number };
    docker: { available: boolean };
    storage: { writeMBps: number };
  };
  heartbeat: { memoryAvailableBytes: number; cpuLoadPercent: number } | null;
  currentTaskId: string | null;
  lastSeenAt: string;
}

interface TaskView {
  spec: { taskId: string; role: string; kind: string; title: string };
  state: string;
  nodeId?: string;
  attempts: number;
  reworkRound: number;
  commit?: string;
  mainCommit?: string;
  detachedAt?: number;
  waitingReason?: string;
  detail?: string;
  history: Array<{ at: string; event: string }>;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${HUB}${path}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

const cell = { padding: "0.3rem 0.8rem", borderBottom: "1px solid #ddd", textAlign: "left" as const };

export default async function Home() {
  const [health, nodes, tasks] = await Promise.all([
    get<Health>("/api/health"),
    get<NodeView[]>("/api/nodes"),
    get<TaskView[]>("/api/tasks"),
  ]);

  if (!health) {
    return (
      <main>
        <h1>AI Swarm Orchestrator</h1>
        <p>Hub unreachable at {HUB}.</p>
      </main>
    );
  }

  return (
    <main>
      {/* Plain auto-refresh until the dashboard gets a live WebSocket feed. */}
      <meta httpEquiv="refresh" content="5" />
      <h1>AI Swarm Orchestrator</h1>
      <p>
        Hub {health.status} · target <code>{health.targetDir}</code> · up {health.uptimeSec}s
      </p>

      <h2>Nodes ({nodes?.length ?? 0})</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Node", "Kind", "Roles", "CPU", "RAM free / total", "Disk write", "Docker", "Task"].map((h) => (
              <th key={h} style={cell}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {nodes?.map((n) => (
            <tr key={n.nodeId}>
              <td style={cell}>
                {n.nodeId}
                {n.hardware && <div style={{ color: "#777", fontSize: "0.8em" }}>{n.hardware.distro}</div>}
              </td>
              <td style={cell}>{n.nodeKind}</td>
              <td style={cell}>{n.roles?.join(", ") ?? "—"}</td>
              <td style={cell}>
                {n.hardware ? `${n.hardware.cpu.logicalCores} threads` : "—"}
                {n.heartbeat && ` · ${n.heartbeat.cpuLoadPercent}%`}
              </td>
              <td style={cell}>
                {n.hardware
                  ? `${((n.heartbeat?.memoryAvailableBytes ?? 0) / GiB).toFixed(1)} / ${(n.hardware.memory.totalBytes / GiB).toFixed(1)} GiB`
                  : "—"}
              </td>
              <td style={cell}>{n.hardware ? `${n.hardware.storage.writeMBps} MB/s` : "—"}</td>
              <td style={cell}>{n.hardware ? (n.hardware.docker.available ? "yes" : "no") : "—"}</td>
              <td style={cell}>{n.currentTaskId ?? (n.nodeKind === "worker" ? "idle" : "—")}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Tasks ({tasks?.length ?? 0})</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Task", "Role / kind", "State", "Node", "Rework", "Commit", "Latest"].map((h) => (
              <th key={h} style={cell}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tasks?.map((t) => (
            <tr key={t.spec.taskId}>
              <td style={cell}>
                {t.spec.taskId}
                <div style={{ color: "#777", fontSize: "0.8em" }}>{t.spec.title}</div>
              </td>
              <td style={cell}>{t.spec.role} / {t.spec.kind}</td>
              <td style={cell}>
                {t.state}
                {t.detachedAt !== undefined && <div style={{ color: "#b45309", fontSize: "0.8em" }}>node offline, held</div>}
              </td>
              <td style={cell}>{t.nodeId ?? "—"}</td>
              <td style={cell}>{t.reworkRound || "—"}</td>
              <td style={cell}>
                <code>{(t.mainCommit ?? t.commit)?.slice(0, 8) ?? "—"}</code>
              </td>
              <td style={{ ...cell, fontSize: "0.85em" }}>
                {t.state === "pending" && t.waitingReason ? t.waitingReason : t.history.at(-1)?.event}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
