import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  IMAGE_MAX_BYTES,
  QA_SCREENSHOTS_MAX,
  QA_SCREENSHOTS_MAX_BYTES,
  SCREENSHOT_SCRIPT,
  ScreenshotNameSchema,
  type MessageOf,
  type ScreenshotTarget,
} from "@aso/shared";
import { probeImage } from "./agent/image.js";

export type Screenshot = NonNullable<Extract<MessageOf<"FEEDBACK_LOOP">["payload"], { outcome: "pass" }>["screenshots"]>[number];

/** Whether the checkout's package.json defines the screenshots script. */
export async function hasScreenshotScript(repoDir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    return typeof pkg.scripts?.[SCREENSHOT_SCRIPT] === "string";
  } catch {
    return false;
  }
}

/**
 * The images a screenshots script saved in `dir` (top level only), in name order, within the
 * limits: each up to IMAGE_MAX_BYTES, at most QA_SCREENSHOTS_MAX of them and
 * QA_SCREENSHOTS_MAX_BYTES together. `skipped` says, in words, what was left out and why.
 */
export async function collectScreenshots(dir: string): Promise<{ screenshots: Screenshot[]; skipped: string[] }> {
  const screenshots: Screenshot[] = [];
  const skipped: string[] = [];
  let total = 0;
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (!ScreenshotNameSchema.safeParse(name).success) {
      skipped.push(`${name} (name not allowed: letters, digits and ._- only)`);
      continue;
    }
    if (info.size > IMAGE_MAX_BYTES) {
      skipped.push(`${name} (over ${IMAGE_MAX_BYTES / 1_000_000} MB)`);
      continue;
    }
    const buf = await readFile(file);
    const image = probeImage(buf);
    if (!image) {
      skipped.push(`${name} (not a PNG, JPEG, GIF or WebP image)`);
      continue;
    }
    if (screenshots.length === QA_SCREENSHOTS_MAX) {
      skipped.push(`${name} (over ${QA_SCREENSHOTS_MAX} screenshots)`);
      continue;
    }
    if (total + buf.length > QA_SCREENSHOTS_MAX_BYTES) {
      skipped.push(`${name} (over ${QA_SCREENSHOTS_MAX_BYTES / 1_000_000} MB together)`);
      continue;
    }
    total += buf.length;
    screenshots.push({ name, mediaType: image.mediaType, data: buf.toString("base64") });
  }
  return { screenshots, skipped };
}

/**
 * The views the developer listed that the script did not save (no `<name>.png` among the kept
 * screenshots), in list order, so the reviewer knows what is missing rather than just a count.
 */
export function missingViews(targets: readonly ScreenshotTarget[] | undefined, screenshots: readonly Pick<Screenshot, "name">[]): string[] {
  const saved = new Set(screenshots.map((s) => s.name));
  return (targets ?? []).map((t) => t.name).filter((name) => !saved.has(`${name}.png`));
}
