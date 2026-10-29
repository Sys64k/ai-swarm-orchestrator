"use client";

import Link from "next/link";
import { useState } from "react";
import { hubAction, usePoll } from "./use-poll.ts";
import { PlanThread, ReplyBox } from "./plan-thread.tsx";
import { Terminal } from "./terminal.tsx";
import { ActionButton, Badge, Banner, LoadingPage, Section, TopBar } from "./ui.tsx";
import type { Plan, Task } from "../lib/types.ts";
import { firstLine, formatUsd, planBadge, planProgress, planThread, replyMode, taskBadge } from "../lib/view.ts";

export function PlanPage({ id }: { id: string }) {
  const { data: plan, error, refresh } = usePoll<Plan>(`plans/${id}`);
  const tasks = usePoll<Task[]>("tasks");
  const [showWork, setShowWork] = useState(false);

  if (!plan) return <LoadingPage title="Plan" back="/" error={error} />;

  const decide = (action: "approve" | "reject") => async () => {
    const err = await hubAction(`plans/${id}/${action}`);
    refresh();
    tasks.refresh();
    return err;
  };
  const reply = async (message: string) => {
    const err = await hubAction(`plans/${id}/reply`, { message });
    refresh();
    return err;
  };
  const mode = replyMode(plan);
  const progress = planProgress(plan, tasks.data ?? []);
  const taskFor = (key: string) => {
    const taskId = plan.taskIds?.[key];
    return taskId ? tasks.data?.find((t) => t.spec.taskId === taskId) : undefined;
  };

  return (
    <>
      <TopBar title={firstLine(plan.requirement, 60)} back={`/projects/${plan.project}`} />
      <main className={`page${plan.state === "proposed" ? " page-with-bar" : ""}`}>
        <div className="hero">
          <Badge {...planBadge(plan)} />
          <div className="chips">
            <Link href={`/projects/${plan.project}`} className="chip chip-link">
              {plan.project}
            </Link>
            {progress.total > 0 && <span className="chip">{progress.merged} of {progress.total} merged</span>}
            {plan.llm.calls > 0 && <span className="chip">planning {formatUsd(plan.llm.costUsd)}</span>}
          </div>
          {plan.error && <Banner tone="bad">{plan.error}</Banner>}
        </div>

        <Section title="Conversation">
          <PlanThread items={planThread(plan)} />
          {mode === "answer" && <ReplyBox mode="answer" send={reply} />}
        </Section>

        {plan.state === "pending" && <p className="muted">Waiting for the Architect to pick this up.</p>}
        {plan.state === "planning" && <p className="muted">The Architect is exploring the project and writing the plan.</p>}
        {plan.state === "awaiting_input" && (
          <div className="stack">
            <p className="muted small">Answer what you can. The Architect plans with your answers, and may ask again if something important is still open.</p>
            <ActionButton label="Reject the plan" variant="plain" confirm="Reject this plan?" run={decide("reject")} />
          </div>
        )}

        {plan.summary && (
          <Section title="Approach">
            <p className="prose">{plan.summary}</p>
          </Section>
        )}

        {plan.tasks && (
          <Section title="Tasks" count={plan.tasks.length}>
            <ol className="plan-tasks">
              {plan.tasks.map((t, i) => {
                const task = taskFor(t.key);
                const body = (
                  <>
                    <span className="plan-task-head">
                      <span className="plan-task-n">{i + 1}</span>
                      <span className="row-title">{t.title}</span>
                      {task && <Badge {...taskBadge(task)} />}
                    </span>
                    <span className="chips">
                      <span className="chip">{t.role}</span>
                      {t.testsFirst && <span className="chip">tests first</span>}
                      {t.dependsOn.length > 0 && <span className="chip">after {t.dependsOn.join(", ")}</span>}
                    </span>
                    {!task && (
                      <details className="plan-task-more">
                        <summary>Details</summary>
                        <p className="prose small">{t.description}</p>
                        {t.acceptanceCriteria.length > 0 && (
                          <ul className="list small">
                            {t.acceptanceCriteria.map((c) => (
                              <li key={c}>{c}</li>
                            ))}
                          </ul>
                        )}
                      </details>
                    )}
                  </>
                );
                return (
                  <li key={t.key} className="plan-task">
                    {task ? (
                      <Link href={`/tasks/${task.spec.taskId}`} className="plan-task-link">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ol>
          </Section>
        )}

        {mode === "changes" && (
          <Section title="Not quite right?">
            <ReplyBox mode="changes" send={reply} />
          </Section>
        )}

        <Section title="How the Architect worked">
          {showWork || plan.state === "planning" ? (
            <Terminal source={`plans/${id}/transcript`} live={plan.state === "planning" || plan.state === "pending"} />
          ) : (
            <button type="button" className="button button-plain" onClick={() => setShowWork(true)}>
              Show
            </button>
          )}
        </Section>
      </main>

      {plan.state === "proposed" && (
        <div className="bottom-bar">
          <ActionButton label="Reject" variant="plain" confirm="Reject this plan?" run={decide("reject")} />
          <ActionButton label="Approve and start" run={decide("approve")} />
        </div>
      )}
    </>
  );
}
