"use client";

import Link from "next/link";
import { hubAction, usePoll } from "./use-poll.ts";
import { ActionButton, Badge, Banner, LoadingPage, Row, Section, TopBar } from "./ui.tsx";
import type { WorkerAction } from "../lib/hub-routes.ts";
import { useState } from "react";
import type { Desks, HubNode, Models, Task } from "../lib/types.ts";
import { agentRows, deskModelChoices, deskModelOf, machineModelOf, workerView, type AgentRow } from "../lib/view.ts";
import { ModelPicker } from "./model-picker.tsx";

/** One worker: what it runs, and draining or restarting it. */
export function WorkerPage({ id }: { id: string }) {
  const { data: nodes, error, refresh } = usePoll<HubNode[]>("nodes", 3000);
  const { data: tasks } = usePoll<Task[]>("tasks", 5000);
  const { data: models } = usePoll<Models>("models", 30000);
  const { data: desks, refresh: refreshDesks } = usePoll<Desks>("desks", 5000);

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
  const host = node.hardware?.hostname ?? "";
  const slots = node.slots ?? 1;
  const choices = models ? deskModelChoices(models, desks, node) : undefined;
  /** Put `target` (a desk or the whole machine) on a model; the Hub's error, if any. */
  const choose = async (target: string, model: string) => {
    const err = await hubAction("desks", { target, model });
    refreshDesks();
    return err;
  };
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
        {node.localModels?.length ? (
          <p className="muted small">
            Serves its own model{node.localModels.length === 1 ? "" : "s"}: {node.localModels.map((m) => m.id).join(", ")}. Its desks use{" "}
            {node.defaultLocalModel ?? node.localModels[0].id} for its own jobs, free for the Hub, unless put on another model.
          </p>
        ) : null}
        {choices && models && (
          <ModelPicker
            label="Model for all desks"
            choices={choices}
            value={machineModelOf(desks, host, slots)}
            onChoose={(model) => choose(host, model)}
          />
        )}
        <Section title="Agents" count={agentRows(node, tasks ?? []).length}>
          <div className="card-list">
            {agentRows(node, tasks ?? []).map((agent) => (
              <div key={agent.slot}>
                <AgentLine agent={agent} />
                {choices && models && (
                  <ModelPicker
                    label={`Model for ${agent.name}`}
                    choices={choices}
                    value={deskModelOf(desks, host, agent.slot)}
                    onChoose={(model) => choose(`${host}#${agent.slot}`, model)}
                  />
                )}
              </div>
            ))}
          </div>
        </Section>
        {models?.localError && <p className="muted small">Some providers&apos; models couldn&apos;t be listed: {models.localError}</p>}
        <p className="muted small">
          <strong>Drain</strong> lets the current job finish but gives this worker no new ones, for example before you take the machine offline.{" "}
          <strong>Restart</strong> drains it, then restarts it on the aso build installed there, so it also finishes an <code>aso update</code>.
        </p>
        <p className="muted small">
          <strong>Model</strong>: each desk builds and tests with the model you pick; a local model takes one request at a time. A
          change applies to the desk&apos;s next job. Models come from the <Link href="/providers">model providers</Link>.
        </p>
      </main>
    </>
  );
}

/** One desk: what its agent does now, or what it did last. */
function AgentLine({ agent }: { agent: AgentRow }) {
  const doing = agent.now ? `${agent.now.job === "test" ? "Testing" : "Building"}: ${agent.now.title}` : undefined;
  const last = agent.last ? `Last ${agent.last.job === "test" ? "tested" : "built"}: ${agent.last.title}` : undefined;
  const badge = agent.now ? (
    <Badge label={agent.now.job === "test" ? "Testing" : "Working"} tone="active" />
  ) : (
    <Badge label="Idle" tone="muted" />
  );
  const taskId = agent.now?.taskId ?? agent.last?.taskId;
  if (!taskId) {
    return (
      <div className="row">
        <span className="row-main">
          <span className="row-title">{agent.name}</span>
          <span className="row-sub">Nothing yet</span>
        </span>
        {badge}
      </div>
    );
  }
  return <Row href={`/tasks/${taskId}`} title={agent.name} sub={doing ?? last} badge={badge} />;
}

/** A model dropdown; shows the Hub's error under it when a choice is refused. */
