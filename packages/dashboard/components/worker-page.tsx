"use client";

import Link from "next/link";
import { hubAction, usePoll } from "./use-poll.ts";
import { ActionButton, Badge, Banner, LoadingPage, TopBar } from "./ui.tsx";
import type { WorkerAction } from "../lib/hub-routes.ts";
import type { HubNode } from "../lib/types.ts";
import { workerView } from "../lib/view.ts";

/** One worker: what it runs, and draining or restarting it. */
export function WorkerPage({ id }: { id: string }) {
  const { data: nodes, error, refresh } = usePoll<HubNode[]>("nodes", 3000);

  if (!nodes) return <LoadingPage title="Worker" back="/" error={error} />;
  const node = nodes.find((n) => n.nodeId === id && n.nodeKind === "worker");
  if (!node) {
    return (
      <>
        <TopBar title="Worker" back="/" />
        <main className="page">
          <p>{id} is not connected.</p>
          <p className="muted small">
            A restarted worker comes back under a new name within a few seconds: find it on the <Link href="/">home page</Link>.
          </p>
        </main>
      </>
    );
  }

  const w = workerView(node);
  const act = (action: WorkerAction) => async () => {
    const err = await hubAction(`nodes/${id}/${action}`);
    refresh();
    return err;
  };

  return (
    <>
      <TopBar title={w.name} back="/" />
      <main className="page">
        <div className="hero">
          <Badge {...w.status} />
          <div className="chips">
            <span className="chip">{w.nodeId}</span>
            {w.taskIds.map((taskId) => (
              <Link key={taskId} href={`/tasks/${taskId}`} className="chip chip-link">
                on {taskId}
              </Link>
            ))}
          </div>
          <p className="muted small">{w.detail}</p>
          {w.updateNote && <Banner tone="waiting">{w.updateNote}</Banner>}
          <div className="actions">
            {w.actions.restart && (
              <ActionButton label="Restart" confirm={w.actions.restartConfirm} run={act("restart")} />
            )}
            {w.actions.drain && <ActionButton label="Drain" variant="plain" run={act("drain")} />}
            {w.actions.resume && <ActionButton label={w.actions.resumeLabel} variant="plain" run={act("resume")} />}
          </div>
          {w.actions.restartNote && <p className="muted small">{w.actions.restartNote}</p>}
        </div>
        <p className="muted small">
          <strong>Drain</strong> lets the current job finish but gives this worker no new ones, for example before you take the machine offline.{" "}
          <strong>Restart</strong> drains it, then restarts it on the aso build installed there, so it also finishes an <code>aso update</code>.
        </p>
      </main>
    </>
  );
}
