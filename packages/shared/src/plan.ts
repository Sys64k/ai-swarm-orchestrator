import type { PlannedTask } from "./protocol.js";

/** Order tasks so dependencies come first; error string on unknown keys, duplicates or cycles. */
export function orderPlan(tasks: readonly PlannedTask[]): PlannedTask[] | string {
  const byKey = new Map<string, PlannedTask>();
  for (const t of tasks) {
    if (byKey.has(t.key)) return `duplicate task key "${t.key}"`;
    byKey.set(t.key, t);
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.key) return `task "${t.key}" depends on itself`;
      if (!byKey.has(d)) return `task "${t.key}" depends on unknown key "${d}"`;
    }
  }
  const ordered: PlannedTask[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: PlannedTask): string | undefined => {
    if (state.get(t.key) === "done") return undefined;
    if (state.get(t.key) === "visiting") return `dependency cycle through "${t.key}"`;
    state.set(t.key, "visiting");
    for (const d of t.dependsOn) {
      const err = visit(byKey.get(d)!);
      if (err) return err;
    }
    state.set(t.key, "done");
    ordered.push(t);
    return undefined;
  };
  for (const t of tasks) {
    const err = visit(t);
    if (err) return err;
  }
  return ordered;
}
