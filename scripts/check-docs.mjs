// Check every relative link in the documentation: the file exists, and an #anchor matches a
// heading in it (GitHub's anchor rules). Run by `npm test`; prints each broken link and fails.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const files = ["README.md", "ARCHITECTURE.md", "SECURITY.md", ...readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to hyphens; repeats get -1, -2. */
function anchorsOf(file) {
  const seen = new Map();
  const anchors = new Set();
  let fence = false;
  for (const line of readFileSync(path.join(root, file), "utf8").split("\n")) {
    if (line.startsWith("```")) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = m[1].trim().toLowerCase().replace(/`/g, "").replace(/[^\w\- ]/g, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n ? `${base}-${n}` : base);
  }
  return anchors;
}

const broken = [];
for (const file of files) {
  let fence = false;
  for (const [i, line] of readFileSync(path.join(root, file), "utf8").split("\n").entries()) {
    if (line.startsWith("```")) fence = !fence;
    if (fence) continue;
    for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [p, frag] = target.split("#");
      const resolved = p ? path.normalize(path.join(path.dirname(file), p)) : file;
      if (!existsSync(path.join(root, resolved))) broken.push(`${file}:${i + 1}: ${target} (no such file)`);
      else if (frag && resolved.endsWith(".md") && !anchorsOf(resolved).has(frag)) broken.push(`${file}:${i + 1}: ${target} (no such heading)`);
    }
  }
}
if (broken.length) {
  console.error(`broken documentation links:\n  ${broken.join("\n  ")}`);
  process.exit(1);
}
console.log(`documentation links: ${files.length} files, all links resolve`);
