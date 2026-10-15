"use client";

import Link from "next/link";
import { usePoll } from "./use-poll.ts";
import { Badge, Banner, Row, Section, TopBar } from "./ui.tsx";
import { NeedsYou, WorkLists } from "./work-lists.tsx";
import type { HubNode, Llm, Plan, Project, Task } from "../lib/types.ts";
import { formatUsd, projectSummary, workerViews } from "../lib/view.ts";

/** Everything at a glance: what needs you, the projects, what's running, the workers. */
export function Home() {
  const tasks = usePoll<Task[]>("tasks");
  const plans = usePoll<Plan[]>("plans");
  const projects = usePoll<Project[]>("projects", 5000);
  const nodes = usePoll<HubNode[]>("nodes", 5000);
  const llm = usePoll<Llm>("llm", 10_000);

  const workers = workerViews(nodes.data ?? []);
  const architect = nodes.data?.some((n) => n.nodeKind === "architect");
  const error = tasks.error ?? plans.error ?? projects.error;
  const ready = tasks.data && plans.data && projects.data;
  const several = (projects.data?.length ?? 0) > 1;

  return (
    <>
      <TopBar title="ASO" right={llm.data && <span className="topbar-meta">{formatUsd(llm.data.totals.costUsd)}</span>} />
      <main className="page">
        {error && <Banner tone="bad">Hub unreachable: {error}</Banner>}
        {llm.data && !llm.data.configured && <Banner tone="waiting">No model configured on the Hub: set ANTHROPIC_API_KEY.</Banner>}
        {!ready && !error && <p className="muted">Loading…</p>}

        {ready && <NeedsYou tasks={tasks.data!} plans={plans.data!} showProject={several} />}

        {ready && (
          <Section title="Projects" count={projects.data!.length}>
            <div className="card-list">
              {projects.data!.map((p) => {
                const s = projectSummary(p);
                return <Row key={p.id} href={`/projects/${p.id}`} title={p.id} sub={s.text} badge={s.needsYou ? <Badge label="Needs you" tone="waiting" /> : undefined} />;
              })}
              <Link href="/projects/new" className="row row-add">
                + New project
              </Link>
            </div>
          </Section>
        )}

        {ready && <WorkLists tasks={tasks.data!} plans={plans.data!} showProject={several} sections={["running"]} />}

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

        <p className="footer-links">
          <Link href="/notifications">Notifications</Link>
          <span aria-hidden> · </span>
          <Link href="/devices">Sign in another device</Link>
        </p>
      </main>
      {projects.data?.length ? (
        <Link href={projects.data.length === 1 ? `/plans/new?project=${projects.data[0].id}` : "/plans/new"} className="fab">
          + New plan
        </Link>
      ) : null}
    </>
  );
}
