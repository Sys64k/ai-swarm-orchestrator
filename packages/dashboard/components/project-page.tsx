"use client";

import Link from "next/link";
import { usePoll } from "./use-poll.ts";
import { Banner, LoadingPage, TopBar } from "./ui.tsx";
import { NeedsYou, WorkLists } from "./work-lists.tsx";
import type { Plan, Project, Task } from "../lib/types.ts";

/** One project: what needs you there, its plans, running, queued and finished work. */
export function ProjectPage({ id }: { id: string }) {
  const project = usePoll<Project>(`projects/${id}`, 5000);
  const tasks = usePoll<Task[]>(`tasks?project=${id}`);
  const plans = usePoll<Plan[]>(`plans?project=${id}`);

  if (!project.data) return <LoadingPage title={id} back="/" error={project.error} />;
  const ready = tasks.data && plans.data;
  const empty = ready && tasks.data!.length === 0 && plans.data!.length === 0;

  return (
    <>
      <TopBar title={id} back="/" />
      <main className="page">
        <p className="muted small mono path">{project.data.dir}</p>
        {(tasks.error ?? plans.error) && <Banner tone="bad">{tasks.error ?? plans.error}</Banner>}
        {empty && <p className="muted">Nothing here yet. Start with a plan: describe what you want built.</p>}
        {ready && (
          <>
            <NeedsYou tasks={tasks.data!} plans={plans.data!} showProject={false} />
            <WorkLists tasks={tasks.data!} plans={plans.data!} showProject={false} sections={["plans", "running", "queued", "done"]} />
          </>
        )}
      </main>
      <Link href={`/plans/new?project=${id}`} className="fab">
        + New plan
      </Link>
    </>
  );
}
