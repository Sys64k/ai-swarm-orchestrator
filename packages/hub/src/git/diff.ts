import type { DiffFile } from "@aso/shared";

/** A file's patch beyond this is left out (the file is still listed). */
export const MAX_FILE_PATCH = 100_000;
/** Patches stop being included once the answer holds this much. */
export const MAX_TOTAL_PATCH = 1_000_000;

/**
 * A diff as files: `numstat` is `git diff --numstat -z --no-renames`, `patch` the same diff in
 * full (`git diff --no-renames`). Git lists the files in the same order in both.
 */
export function parseDiff(numstat: string, patch: string, limits = { file: MAX_FILE_PATCH, total: MAX_TOTAL_PATCH }): { files: DiffFile[]; truncated: boolean } {
  const stats = numstat
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const [added, deleted, ...rest] = entry.split("\t");
      return { path: rest.join("\t"), binary: added === "-", additions: Number(added) || 0, deletions: Number(deleted) || 0 };
    });
  const chunks = splitPatch(patch);
  let total = 0;
  let truncated = false;
  const files = stats.map((stat, i): DiffFile => {
    const chunk = chunks[i] ?? "";
    const status = /^new file mode /m.test(chunk) ? "added" : /^deleted file mode /m.test(chunk) ? "deleted" : "modified";
    const file: DiffFile = { path: stat.path, status, additions: stat.additions, deletions: stat.deletions, binary: stat.binary };
    if (stat.binary || !chunk) return file;
    if (chunk.length > limits.file || total + chunk.length > limits.total) {
      truncated = true;
      return file;
    }
    total += chunk.length;
    return { ...file, patch: chunk };
  });
  return { files, truncated };
}

/** A whole-diff patch split per file, at each `diff --git` header. */
function splitPatch(patch: string): string[] {
  const chunks: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) chunks.push(line);
    else if (chunks.length) chunks[chunks.length - 1] += `\n${line}`;
  }
  return chunks.map((c) => c.replace(/\n+$/, ""));
}
