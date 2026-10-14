"use client";

import Link from "next/link";
import { usePoll } from "./use-poll.ts";
import { Badge, Banner, Row, Section, TopBar } from "./ui.tsx";
import type { Health, HubNode, Llm, Plan, Task } from "../lib/types.ts";
import { firstLine, formatUsd, homeView, planBadge, planProgress, taskBadge, timeAgo, workerViews } from "../lib/view.ts";

const DONE_SHOWN = 8;

export function Home() {
  const tasks = usePoll<Task[]>("tasks");
  const plans = usePoll<Plan[]>("plans");
  const nodes = usePoll<HubNode[]>("nodes", 5000);
  const llm = usePoll<Llm>("llm", 10_000);
  const health = usePoll<Health>("health", 10_000);

  const project = health.data?.targetDir?.split("/").filter(Boolean).at(-1) ?? "ASO";
  const view = tasks.data && plans.data ? homeView(tasks.data, plans.data) : undefined;
  const workers = workerViews(nodes.data ?? []);
  const architect = nodes.data?.some((n) => n.nodeKind === "architect");
  const error = tasks.error ?? plans.error;

  return (
    <>
      <TopBar title={project} right={llm.data && <span className="topbar-meta">{formatUsd(llm.data.totals.costUsd)}</span>} />
      <main className="page">
        {error && <Banner tone="bad">Hub unreachable: {error}</Banner>}
        {llm.data && !llm.data.configured && <Banner tone="waiting">No model configured on the Hub: set ANTHROPIC_API_KEY.</Banner>}
        {!view && !error && <p className="muted">Loading…</p>}

        {view && view.attention.length > 0 && (
          <Section title="Needs you" count={view.attention.length}>
            <div className="card-list">
              {view.attention.map((a) => (
                <Row
                  key={`${a.kind}-${a.id}`}
                  href={a.href}
                  title={a.title}
                  sub={a.reason}
                  badge={<Badge {...a.badge} />}
                />
              ))}
            </div>
          </Section>
        )}

        {view && view.activePlans.length > 0 && (
          <Section title="Plans">
            <div className="card-list">
              {view.activePlans.map((p) => {
                const progress = planProgress(p, tasks.data ?? []);
                const b = planBadge(p);
                return (
                  <Row
                    key={p.planId}
                    href={`/plans/${p.planId}`}
                    title={firstLine(p.requirement)}
                    sub={progress.total ? `${progress.merged} of ${progress.total} tasks merged` : timeAgo(p.updatedAt)}
                    badge={<Badge {...b} />}
                  />
                );
              })}
            </div>
          </Section>
        )}

        {view && (
          <Section title="Running" count={view.running.length}>
            {view.running.length === 0 ? (
              <p className="muted">Nothing running.</p>
            ) : (
              <div className="card-list">
                {view.running.map((t) => (
                  <Row key={t.spec.taskId} href={`/tasks/${t.spec.taskId}`} title={t.spec.title} sub={latest(t)} badge={<Badge {...taskBadge(t)} />} />
                ))}
              </div>
            )}
          </Section>
        )}

        {view && view.queued.length > 0 && (
          <Section title="Queued" count={view.queued.length}>
            <div className="card-list">
              {view.queued.map((t) => (
                <Row key={t.spec.taskId} href={`/tasks/${t.spec.taskId}`} title={t.spec.title} sub={t.waitingReason} badge={<Badge {...taskBadge(t)} />} />
              ))}
            </div>
          </Section>
        )}

        <Section title="Workers" count={workers.length}>
          {workers.length === 0 ? (
            <p className="muted">No workers connected. Start one with <code>aso start-worker</code>.</p>
          ) : (
            <div className="card-list">
              {workers.map((w) => (
                <div key={w.nodeId} className="row row-static">
                  <span className="row-main">
                    <span className="row-title">{w.name}</span>
                    <span className="row-sub">{w.detail}</span>
                  </span>
                  {w.busy ? (
                    <Link href={`/tasks/${w.taskId}`}>
                      <Badge label="Busy" tone="active" />
                    </Link>
                  ) : (
                    <Badge label="Idle" tone="muted" />
                  )}
                </div>
              ))}
            </div>
          )}
          {nodes.data && !architect && <p className="muted small">The Architect is not connected, so new plans will wait.</p>}
        </Section>

        {view && view.done.length > 0 && (
          <Section title="Done" count={view.done.length}>
            <div className="card-list">
              {view.done.slice(0, DONE_SHOWN).map((t) => (
                <Row key={t.spec.taskId} href={`/tasks/${t.spec.taskId}`} title={t.spec.title} sub={timeAgo(t.updatedAt)} badge={<Badge {...taskBadge(t)} />} />
              ))}
            </div>
          </Section>
        )}
      </main>
      <Link href="/plans/new" className="fab">
        + New plan
      </Link>
    </>
  );
}

function latest(t: Task): string {
  return firstLine(t.history.at(-1)?.event ?? "", 90);
}
