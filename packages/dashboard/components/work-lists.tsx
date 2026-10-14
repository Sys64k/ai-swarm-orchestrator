"use client";

import { Badge, Row, Section } from "./ui.tsx";
import type { Plan, Task } from "../lib/types.ts";
import { firstLine, homeView, planBadge, planProgress, taskBadge, timeAgo } from "../lib/view.ts";

const DONE_SHOWN = 8;

/** "Needs you" items for the given tasks and plans (all projects, or one). */
export function NeedsYou({ tasks, plans, showProject }: { tasks: Task[]; plans: Plan[]; showProject: boolean }) {
  const { attention } = homeView(tasks, plans);
  if (!attention.length) return null;
  return (
    <Section title="Needs you" count={attention.length}>
      <div className="card-list">
        {attention.map((a) => (
          <Row
            key={`${a.kind}-${a.id}`}
            href={a.href}
            title={a.title}
            sub={showProject ? `${a.project} · ${a.reason}` : a.reason}
            badge={<Badge {...a.badge} />}
          />
        ))}
      </div>
    </Section>
  );
}

/** Plans in progress, running, queued and finished tasks. */
export function WorkLists({ tasks, plans, showProject, sections }: {
  tasks: Task[];
  plans: Plan[];
  showProject: boolean;
  sections: Array<"plans" | "running" | "queued" | "done">;
}) {
  const view = homeView(tasks, plans);
  const sub = (t: Task, text: string | undefined) => (showProject ? [t.project, text].filter(Boolean).join(" · ") : text);
  return (
    <>
      {sections.includes("plans") && view.activePlans.length > 0 && (
        <Section title="Plans">
          <div className="card-list">
            {view.activePlans.map((p) => {
              const progress = planProgress(p, tasks);
              return (
                <Row
                  key={p.planId}
                  href={`/plans/${p.planId}`}
                  title={firstLine(p.requirement)}
                  sub={progress.total ? `${progress.merged} of ${progress.total} tasks merged` : timeAgo(p.updatedAt)}
                  badge={<Badge {...planBadge(p)} />}
                />
              );
            })}
          </div>
        </Section>
      )}

      {sections.includes("running") && (
        <Section title="Running" count={view.running.length}>
          {view.running.length === 0 ? (
            <p className="muted">Nothing running.</p>
          ) : (
            <div className="card-list">
              {view.running.map((t) => (
                <Row
                  key={t.spec.taskId}
                  href={`/tasks/${t.spec.taskId}`}
                  title={t.spec.title}
                  sub={sub(t, firstLine(t.history.at(-1)?.event ?? "", 90))}
                  badge={<Badge {...taskBadge(t)} />}
                />
              ))}
            </div>
          )}
        </Section>
      )}

      {sections.includes("queued") && view.queued.length > 0 && (
        <Section title="Queued" count={view.queued.length}>
          <div className="card-list">
            {view.queued.map((t) => (
              <Row key={t.spec.taskId} href={`/tasks/${t.spec.taskId}`} title={t.spec.title} sub={sub(t, t.waitingReason)} badge={<Badge {...taskBadge(t)} />} />
            ))}
          </div>
        </Section>
      )}

      {sections.includes("done") && view.done.length > 0 && (
        <Section title="Done" count={view.done.length}>
          <div className="card-list">
            {view.done.slice(0, DONE_SHOWN).map((t) => (
              <Row key={t.spec.taskId} href={`/tasks/${t.spec.taskId}`} title={t.spec.title} sub={sub(t, timeAgo(t.updatedAt))} badge={<Badge {...taskBadge(t)} />} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
