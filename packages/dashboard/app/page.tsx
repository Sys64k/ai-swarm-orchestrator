export const dynamic = "force-dynamic";

interface Health {
  status: string;
  targetDir: string;
  connections: number;
  uptimeSec: number;
}

async function getHealth(): Promise<Health | null> {
  const port = process.env.ASO_HUB_PORT ?? "7420";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

export default async function Home() {
  const health = await getHealth();
  return (
    <main>
      <h1>AI Swarm Orchestrator</h1>
      {health ? (
        <dl>
          <dt>Hub</dt>
          <dd>{health.status}</dd>
          <dt>Target project</dt>
          <dd>
            <code>{health.targetDir}</code>
          </dd>
          <dt>Connected agents</dt>
          <dd>{health.connections}</dd>
          <dt>Uptime</dt>
          <dd>{health.uptimeSec}s</dd>
        </dl>
      ) : (
        <p>Hub unreachable.</p>
      )}
    </main>
  );
}
