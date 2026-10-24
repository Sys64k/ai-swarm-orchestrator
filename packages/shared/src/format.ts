/**
 * Short forms the CLI prints. (The console keeps its own copies in `dashboard/lib/view.ts`: it
 * doesn't depend on this package. Keep the wording of both the same.)
 */

/** A commit's or a version's short form: `0.1.0+a914b89` → `a914b89`, a sha → its first 7 characters. */
export function shortCommit(versionOrSha: string): string {
  const plus = versionOrSha.indexOf("+");
  return (plus === -1 ? versionOrSha : versionOrSha.slice(plus + 1)).slice(0, 7);
}

/** A duration: `less than a second`, `42 s`, `3 min 12 s`, `1 h 5 min`. Invalid or negative: `less than a second`. */
export function formatDuration(ms: number): string {
  if (!(ms >= 1000)) return "less than a second";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}
