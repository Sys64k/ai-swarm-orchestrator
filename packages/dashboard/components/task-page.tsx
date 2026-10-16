"use client";

import Link from "next/link";
import { useState } from "react";
import { hubAction, usePoll } from "./use-poll.ts";
import { Terminal } from "./terminal.tsx";
import { ActionButton, Badge, Banner, LoadingPage, Section, TopBar } from "./ui.tsx";
import type { Task } from "../lib/types.ts";
import { formatUsd, isLive, reviewView, taskActions, taskBadge, timeAgo } from "../lib/view.ts";

export function TaskPage({ id }: { id: string }) {
  const { data: task, error, refresh } = usePoll<Task>(`tasks/${id}`);
  const [tab, setTab] = useState<"live" | "details">("live");

  if (!task) return <LoadingPage title={id} back="/" error={error} />;

  const live = isLive(task.state);
  const can = taskActions(task);
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
          {task.state === "pending" && task.waitingReason && <p className="muted small">{task.waitingReason}</p>}
          <div className="actions">
            {can.retry && <ActionButton label="Retry" run={act("retry")} />}
            {can.cancel && (
              <ActionButton label="Cancel task" variant="danger" confirm="Cancel this task? A worker on it stops at its next step." run={act("cancel")} />
            )}
          </div>
        </div>

        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "live"} className="tab" onClick={() => setTab("live")}>
            {live ? "Live" : "Transcript"}
          </button>
          <button type="button" role="tab" aria-selected={tab === "details"} className="tab" onClick={() => setTab("details")}>
            Details
          </button>
        </div>

        {tab === "live" ? (
          <Terminal source={`tasks/${id}/transcript`} live={live} />
        ) : (
          <Details task={task} />
        )}
      </main>
    </>
  );
}

function Details({ task }: { task: Task }) {
  const review = reviewView(task);
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
        {review && (
          <p className="small">
            {review.url ? (
              <a href={review.url} target="_blank" rel="noreferrer">
                {review.text}
              </a>
            ) : (
              review.text
            )}
            {review.error && <span className="muted"> · last try failed: {review.error}</span>}
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
