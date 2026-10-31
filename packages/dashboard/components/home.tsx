"use client";

import Link from "next/link";
import { usePoll } from "./use-poll.ts";
import { Badge, Banner, Row, Section, TopBar } from "./ui.tsx";
import { NeedsYou, WorkLists } from "./work-lists.tsx";
import type { HubNode, HubUpdate, Llm, Notices, Plan, Project, Task } from "../lib/types.ts";
import { formatUsd, hubUpdateView, pausedLines, projectSummary, unreadNotices, workerViews } from "../lib/view.ts";

/** Everything at a glance: what needs you, the projects, what's running, the workers. */
export function Home() {
  const tasks = usePoll<Task[]>("tasks");
  const plans = usePoll<Plan[]>("plans");
  const projects = usePoll<Project[]>("projects", 5000);
  const nodes = usePoll<HubNode[]>("nodes", 5000);
  const llm = usePoll<Llm>("llm", 10_000);
  const update = usePoll<HubUpdate>("hub/update", 10_000);
  const notices = usePoll<Notices>("notices", 10_000);
  const unread = unreadNotices(notices.data);
  // An older Hub has no update status: then nothing is shown.
  const hub = hubUpdateView(update.data);

  const workers = workerViews(nodes.data ?? []);
  const architect = nodes.data?.some((n) => n.nodeKind === "architect");
  const error = tasks.error ?? plans.error ?? projects.error;
  const ready = tasks.data && plans.data && projects.data;
  const several = (projects.data?.length ?? 0) > 1;

  return (
    <>
      <TopBar title="Skynet" right={llm.data && <span className="topbar-meta">{formatUsd(llm.data.totals.costUsd)}</span>} />
      <main className="page page-wide">
        {error && <Banner tone="bad">Hub unreachable: {error}</Banner>}
        {llm.data && !llm.data.configured && <Banner tone="waiting">No model configured on the Hub: set ANTHROPIC_API_KEY.</Banner>}
        {pausedLines(llm.data).map((line) => (
          <Banner key={line} tone="waiting">
            {line}
          </Banner>
        ))}
        {hub?.banner && (
          <Banner tone="bad">
            {hub.label}: {hub.detail}
          </Banner>
        )}
        {unread && (
          <div className="card-list">
            <Row href="/notifications" title={unread.title} sub={unread.latest} badge={<Badge label="New" tone="waiting" />} />
          </div>
        )}
        {!ready && !error && <p className="muted">Loading…</p>}

        <div className="columns columns-home">
          <div className="column">
            {ready && <NeedsYou tasks={tasks.data!} plans={plans.data!} showProject={several} />}
          </div>
          <div className="column column-pair">
            <div className="column">
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
            </div>
            <div className="column">
              {hub && (
                <p className="small hub-status">
                  <Badge label={hub.label} tone={hub.tone} />
                  {hub.detail && !hub.banner && <span className="muted"> {hub.detail}</span>}
                </p>
              )}

              <Section title="Workers" count={workers.length}>
                {workers.length === 0 ? (
                  <p className="muted">No workers connected. Start one with <code>aso start-worker</code>.</p>
                ) : (
                  <div className="card-list">
                    {workers.map((w) => (
                      <Row key={w.nodeId} href={`/workers/${w.nodeId}`} title={w.name} sub={w.detail} badge={<Badge {...w.status} />} />
                    ))}
                  </div>
                )}
                {workers.some((w) => w.outdated) && (
                  <p className="muted small">
                    Workers marked Update run another aso build than the Hub. One installed from the Hub&apos;s package as a service
                    updates itself once idle; on any other, run <code>aso update --hub &lt;hub address&gt;</code>.
                  </p>
                )}
                {nodes.data && !architect && <p className="muted small">The Architect is not connected, so new plans will wait.</p>}
                <p className="small">
                  <Link href="/machines">Worker machines and their keys</Link>
                  <span aria-hidden> · </span>
                  <Link href="/providers">Model providers</Link>
                  <span aria-hidden> · </span>
                  <Link href="/track-records">Track records</Link>
                </p>
              </Section>
            </div>
          </div>
        </div>

        <p className="footer-links">
          <Link href="/notifications">Notices and notifications</Link>
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
