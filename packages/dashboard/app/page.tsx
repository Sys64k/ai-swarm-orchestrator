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

interface LlmView {
  configured: boolean;
  model: string | null;
  taskBudgetUsd: number;
  queue: { running: number; waiting: number; limit: number };
  totals: { calls: number; costUsd: number };
}

interface Turn {
  turn: number;
  actions: string[];
  costUsd: number;
}

interface PlanView {
  planId: string;
  requirement: string;
  state: string;
  summary?: string;
  error?: string;
  tasks?: Array<{ key: string; role: string; title: string; dependsOn: string[] }>;
  taskIds?: Record<string, string>;
  llm: { calls: number; costUsd: number };
}

interface TaskView {
  spec: { taskId: string; role: string; kind: string; title: string; dependsOn: string[] };
  agentLog: Turn[];
  planId?: string;
  state: string;
  nodeId?: string;
  attempts: number;
  reworkRound: number;
  llm: { calls: number; costUsd: number };
  filesTouched: string[];
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
  const [health, nodes, tasks, llm, plans] = await Promise.all([
    get<Health>("/api/health"),
    get<NodeView[]>("/api/nodes"),
    get<TaskView[]>("/api/tasks"),
    get<LlmView>("/api/llm"),
    get<PlanView[]>("/api/plans"),
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
      <p>
        {llm?.configured ? (
          <>
            LLM <code>{llm.model}</code> · {llm.totals.calls} calls · ~${llm.totals.costUsd.toFixed(2)} spent since start ·
            queue {llm.queue.running}/{llm.queue.limit} running, {llm.queue.waiting} waiting · budget ${llm.taskBudgetUsd}/task
          </>
        ) : (
          <span style={{ color: "#b45309" }}>No LLM configured: set ANTHROPIC_API_KEY on the Hub so agents can work.</span>
        )}
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

      <h2>Plans ({plans?.length ?? 0})</h2>
      {plans?.length ? (
        plans.map((p) => (
          <details key={p.planId} open={p.state === "proposed"} style={{ marginBottom: "0.6rem" }}>
            <summary>
              <code>{p.planId}</code> · <strong>{p.state}</strong> · {p.requirement.slice(0, 100)}
              {p.llm.calls > 0 && ` · ${p.llm.calls} turns, ~$${p.llm.costUsd.toFixed(2)}`}
            </summary>
            {p.error && <p style={{ color: "#b91c1c" }}>{p.error}</p>}
            {p.summary && <p style={{ whiteSpace: "pre-wrap" }}>{p.summary}</p>}
            {p.tasks && (
              <ol>
                {p.tasks.map((t) => (
                  <li key={t.key}>
                    [{t.role}] {t.title}
                    {t.dependsOn.length > 0 && <span style={{ color: "#777" }}> (after {t.dependsOn.join(", ")})</span>}
                    {p.taskIds?.[t.key] && <code style={{ color: "#777" }}> → {p.taskIds[t.key]}</code>}
                  </li>
                ))}
              </ol>
            )}
            {p.state === "proposed" && (
              <p>
                Approve with <code>aso plan-approve {p.planId}</code> or reject with <code>aso plan-reject {p.planId}</code>.
              </p>
            )}
          </details>
        ))
      ) : (
        <p style={{ color: "#777" }}>
          No plans yet. Ask the Architect with <code>aso plan "what to build"</code>.
        </p>
      )}

      <h2>Tasks ({tasks?.length ?? 0})</h2>
      <table style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Task", "Role / kind", "State", "Node", "Rework", "LLM", "Commit", "Latest"].map((h) => (
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
                {t.spec.dependsOn.length > 0 && (
                  <div style={{ color: "#777", fontSize: "0.8em" }}>after {t.spec.dependsOn.join(", ")}</div>
                )}
              </td>
              <td style={cell}>{t.spec.role} / {t.spec.kind}</td>
              <td style={cell}>
                {t.state}
                {t.detachedAt !== undefined && <div style={{ color: "#b45309", fontSize: "0.8em" }}>node offline, held</div>}
              </td>
              <td style={cell}>{t.nodeId ?? "—"}</td>
              <td style={cell}>{t.reworkRound || "—"}</td>
              <td style={cell}>
                {t.llm.calls ? `${t.llm.calls} turns · ~$${t.llm.costUsd.toFixed(2)}` : "—"}
                {t.filesTouched.length > 0 && (
                  <div style={{ color: "#777", fontSize: "0.8em" }}>{t.filesTouched.length} files</div>
                )}
              </td>
              <td style={cell}>
                <code>{(t.mainCommit ?? t.commit)?.slice(0, 8) ?? "—"}</code>
              </td>
              <td style={{ ...cell, fontSize: "0.85em" }}>
                {t.state === "pending" && t.waitingReason ? t.waitingReason : t.history.at(-1)?.event}
                {t.agentLog.length > 0 && (
                  <details>
                    <summary style={{ color: "#777" }}>{t.agentLog.length} agent turns</summary>
                    <ol start={0} style={{ margin: 0 }}>
                      {t.agentLog.slice(-15).map((a) => (
                        <li key={`${a.turn}-${a.costUsd}`} value={a.turn}>
                          {a.actions.join(", ")} <span style={{ color: "#999" }}>${a.costUsd.toFixed(3)}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
