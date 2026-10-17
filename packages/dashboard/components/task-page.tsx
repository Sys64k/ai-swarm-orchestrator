"use client";

import Link from "next/link";
import { useState } from "react";
import { hubAction, usePoll } from "./use-poll.ts";
import { ChangesView, ReviewPanel } from "./review-panel.tsx";
import { Terminal } from "./terminal.tsx";
import { ActionButton, Badge, Banner, LoadingPage, Section, TopBar } from "./ui.tsx";
import type { Task } from "../lib/types.ts";
import { canReview, crewLine, currentTab, formatUsd, hasChanges, isLive, reviewLink, reviewView, taskActions, taskBadge, timeAgo, type TaskTab } from "../lib/view.ts";

export function TaskPage({ id }: { id: string }) {
  const { data: task, error, refresh } = usePoll<Task>(`tasks/${id}`);
  const [chosen, setTab] = useState<TaskTab>();

  if (!task) return <LoadingPage title={id} back="/" error={error} />;

  const changes = hasChanges(task);
  const reviewing = canReview(task);
  const tab = currentTab(chosen, task);

  const live = isLive(task.state);
  const can = taskActions(task);
  const review = reviewView(task);
  const pr = reviewLink(task);
  const crew = crewLine(task);
  const act = (action: "cancel" | "retry") => async () => {
    const err = await hubAction(`tasks/${id}/${action}`);
    refresh();
    return err;
  };

  return (
    <>
      <TopBar title={task.spec.title} back={task.planId ? `/plans/${task.planId}` : `/projects/${task.project}`} />
      <main className="page">
        <div className="hero">
          <Badge {...taskBadge(task)} />
          <div className="chips">
            <Link href={`/projects/${task.project}`} className="chip chip-link">
              {task.project}
            </Link>
            <span className="chip">{task.spec.role}</span>
            {task.nodeId && live && <span className="chip">on {task.nodeId}</span>}
            {task.llm.calls > 0 && <span className="chip">{task.llm.calls} turns · {formatUsd(task.llm.costUsd)}</span>}
            {task.reworkRound > 0 && <span className="chip">rework {task.reworkRound}</span>}
            {task.retries ? <span className="chip">retry {task.retries}</span> : null}
          </div>
          {task.state === "failed" && task.detail && <Banner tone="bad">{task.detail}</Banner>}
          {crew && <p className="small">{crew}</p>}
          {task.state === "pending" && task.waitingReason && <p className="muted small">{task.waitingReason}</p>}
          {review && (
            <p className="muted small">
              {review.text}
              {review.error && <> · last try failed: {review.error}</>}
            </p>
          )}
          <div className="actions">
            {pr && (
              <a href={pr.url} target="_blank" rel="noreferrer" className="button button-plain button-link">
                {pr.label}
              </a>
            )}
            {can.retry && <ActionButton label="Retry" run={act("retry")} />}
            {can.cancel && (
              <ActionButton label="Cancel task" variant="danger" confirm="Cancel this task? A worker on it stops at its next step." run={act("cancel")} />
            )}
          </div>
        </div>

        {reviewing && <ReviewPanel taskId={id} onDone={refresh} />}

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "live"} className="tab" onClick={() => setTab("live")}>
            {live ? "Live" : "Transcript"}
          </button>
          {changes && (
            <button type="button" role="tab" aria-selected={tab === "changes"} className="tab" onClick={() => setTab("changes")}>
              Changes
            </button>
          )}
          <button type="button" role="tab" aria-selected={tab === "details"} className="tab" onClick={() => setTab("details")}>
            Details
          </button>
        </div>

        {tab === "live" && <Terminal source={`tasks/${id}/transcript`} live={live} />}
        {tab === "changes" && <ChangesView taskId={id} prUrl={pr?.url} />}
        {tab === "details" && <Details task={task} />}
      </main>
    </>
  );
}

function Details({ task }: { task: Task }) {
  return (
    <>
      <Section title="Task">
        <p className="prose">{task.spec.description}</p>
        {task.spec.acceptanceCriteria.length > 0 && (
          <>
            <h3 className="subhead">Acceptance criteria</h3>
            <ul className="list">
              {task.spec.acceptanceCriteria.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </>
        )}
        {task.spec.dependsOn.length > 0 && (
          <p className="muted small">
            After{" "}
            {task.spec.dependsOn.map((d, i) => (
              <span key={d}>
                {i > 0 && ", "}
                <Link href={`/tasks/${d}`}>{d}</Link>
              </span>
            ))}
          </p>
        )}
        {(task.mainCommit ?? task.commit) && (
          <p className="muted small">
            {task.mainCommit ? "Merged as" : "Commit"} <code>{(task.mainCommit ?? task.commit)!.slice(0, 8)}</code>
          </p>
        )}
      </Section>
      {task.filesTouched.length > 0 && (
        <Section title="Files touched" count={task.filesTouched.length}>
          <ul className="list mono small">
            {task.filesTouched.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="History">
        <ol className="timeline">
          {[...task.history].reverse().map((h, i) => (
            <li key={`${h.at}-${i}`}>
              <span className="timeline-at">{timeAgo(h.at)}</span>
              <span>{h.event}</span>
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
