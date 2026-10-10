import { authorizationHeader, resolveHubUrl, resolveToken } from "@aso/shared";

/** Show push status; POST retries (useful after resolving a conflict in the Hub checkout). */
export async function syncCommand(opts: { hub: string }): Promise<void> {
  const url = resolveHubUrl(opts.hub);
  const base = `${url.protocol === "wss:" ? "https" : "http"}://${url.host}`;
  const token = resolveToken()?.token;
  const res = await fetch(`${base}/api/sync`, {
    method: "POST",
    headers: token ? { authorization: authorizationHeader(token) } : {},
  }).catch(() => {
    throw new Error(`cannot reach the Hub at ${base}`);
  });
  if (res.status === 401) throw new Error("the Hub rejected the ASO token (set ASO_TOKEN)");
  const s = (await res.json()) as { state: string; remote: string; url: string | null; reason?: string; lastPushAt?: string; lastPushedCommit?: string; lastError?: string };
  console.log(`${s.remote} (${s.url ?? "no remote"}): ${s.state}`);
  if (s.reason) console.log(`  ${s.reason}`);
  if (s.lastPushedCommit) console.log(`  last push: ${s.lastPushedCommit.slice(0, 8)} at ${s.lastPushAt}`);
  if (s.lastError) console.log(`  error: ${s.lastError}`);
  if (s.state === "error" || s.state === "conflict") process.exitCode = 1;
}
