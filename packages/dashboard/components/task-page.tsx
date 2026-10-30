"use client";

import Link from "next/link";
import { useState } from "react";
import { hubAction, usePoll } from "./use-poll.ts";
import { EditRetry } from "./edit-retry.tsx";
import { ChangesView, ReviewPanel } from "./review-panel.tsx";
import { Terminal } from "./terminal.tsx";
import { useWide } from "./use-wide.ts";
import { ActionButton, Badge, Banner, LoadingPage, Section, TopBar } from "./ui.tsx";
import type { Task } from "../lib/types.ts";
import { acceptanceView, canReview, crewLine, currentTab, formatUsd, hasChanges, isLive, modelLine, reviewLink, reviewView, screenshotList, taskActions, taskBadge, testsFirstLine, timeAgo, type TaskTab } from "../lib/view.ts";

export function TaskPage({ id }: { id: string }) {
  const { data: task, error, refresh } = usePoll<Task>(`tasks/${id}`);
  const [chosen, setTab] = useState<TaskTab>();
  const wide = useWide();
  const [editing, setEditing] = useState(false);

  if (!task) return <LoadingPage title={id} back="/" error={error} />;

  const changes = hasChanges(task);
  const reviewing = canReview(task);
  const tab = currentTab(chosen, task, wide);

  const live = isLive(task.state);
  const can = taskActions(task);
  const review = reviewView(task);
  const pr = reviewLink(task);
  const crew = [crewLine(task), modelLine(task)].filter(Boolean).join(" · ");
  const testsFirst = testsFirstLine(task);
  const shots = screenshotList(task);
  const act = (action: "cancel" | "retry" | "dismiss") => async () => {
    const err = await hubAction(`tasks/${id}/${action}`);
    refresh();
    return err;
  };

  return (
    <>
      <TopBar title={task.spec.title} back={task.planId ? `/plans/${task.planId}` : `/projects/${task.project}`} />
      <main className="page page-wide columns columns-aside">
        <div className="column column-sticky">
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
            {task.supersededBy && (
              <p className="muted small">
                Superseded by <Link href={`/tasks/${task.supersededBy}`}>{task.supersededBy}</Link>, which does its job: there&apos;s nothing to retry.
              </p>
            )}
            {crew && <p className="small">{crew}</p>}
            {testsFirst && <p className="small">{testsFirst}</p>}
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
              {can.retry && !editing && (
                <button type="button" className="button button-plain" onClick={() => setEditing(true)}>
                  Edit and retry
                </button>
              )}
              {can.dismiss && (
                <ActionButton label="Dismiss" variant="plain" confirm="Dismiss this task? It leaves Needs you; retrying it later brings it back." run={act("dismiss")} />
              )}
              {can.cancel && (
                <ActionButton label="Cancel task" variant="danger" confirm="Cancel this task? A worker on it stops at its next step." run={act("cancel")} />
              )}
            </div>
          </div>

          {reviewing && <ReviewPanel taskId={id} onDone={refresh} />}
          {editing && can.retry && (
            <EditRetry
              task={task}
              onClose={() => {
                setEditing(false);
                refresh();
              }}
            />
          )}
          {wide && <Details task={task} />}
        </div>

        <div className="column">
          <div className="tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "live"} className="tab" onClick={() => setTab("live")}>
              {live ? "Live" : "Transcript"}
            </button>
            {changes && (
              <button type="button" role="tab" aria-selected={tab === "changes"} className="tab" onClick={() => setTab("changes")}>
                Changes
              </button>
            )}
            {shots.length > 0 && (
              <button type="button" role="tab" aria-selected={tab === "screenshots"} className="tab" onClick={() => setTab("screenshots")}>
                Screenshots
              </button>
            )}
            {!wide && (
              <button type="button" role="tab" aria-selected={tab === "details"} className="tab" onClick={() => setTab("details")}>
                Details
              </button>
            )}
          </div>

          {tab === "live" && <Terminal source={`tasks/${id}/transcript`} live={live} />}
          {tab === "changes" && <ChangesView taskId={id} prUrl={pr?.url} />}
          {tab === "screenshots" && <Screenshots shots={shots} commit={task.screenshots!.commit} />}
          {tab === "details" && <Details task={task} />}
        </div>
      </main>
    </>
  );
}

function Screenshots({ shots, commit }: { shots: ReturnType<typeof screenshotList>; commit: string }) {
  return (
    <Section title="Screenshots" count={shots.length}>
      <p className="muted small">
        Taken by QA&apos;s screenshots script on commit <code>{commit.slice(0, 8)}</code>. Tap one for full size.
      </p>
      <div className="shots">
        {shots.map((s) => (
          <figure key={s.name} className="shot">
            <a href={s.url} target="_blank" rel="noreferrer">
              <img src={s.url} alt={s.caption} loading="lazy" />
            </a>
            <figcaption className="small muted">{s.caption}</figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

function AcceptanceCheck({ task }: { task: Task }) {
  const view = acceptanceView(task);
  if (!view) return null;
  return (
    <Section title="Acceptance check">
      <p className="prose">{view.headline}</p>
      {view.criteria.length > 0 && (
        <ul className="list">
          {view.criteria.map((c) => (
            <li key={c.criterion}>
              <strong>{c.label}:</strong> {c.criterion}
              {c.reason && <span className="muted"> ({c.reason})</span>}
            </li>
          ))}
        </ul>
      )}
      {view.notes.length > 0 && (
        <>
          <h3 className="subhead">Quality notes (only weakened tests block)</h3>
          <ul className="list">
            {view.notes.map((n) => (
              <li key={`${n.label}-${n.text}`}>
                <strong>
                  {n.label}
                  {n.blocks && " (blocks)"}:
                </strong>{" "}
                {n.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
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
      <AcceptanceCheck task={task} />
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
