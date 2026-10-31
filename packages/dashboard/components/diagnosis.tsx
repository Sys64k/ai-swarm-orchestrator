"use client";

import { hubAction } from "./use-poll.ts";
import { ActionButton, Section } from "./ui.tsx";
import type { Task } from "../lib/types.ts";
import { diagnosisView } from "../lib/view.ts";

/** The product owner's reading of why the task failed, its evidence, and its proposal to accept or refuse. */
export function DiagnosisCard({ task, onDone }: { task: Task; onDone: () => void }) {
  const view = diagnosisView(task);
  // Refresh either way; the button shows the Hub's error, if any.
  const act = (path: string) => async () => {
    const err = await hubAction(`tasks/${task.spec.taskId}/${path}`);
    onDone();
    return err;
  };
  const ask = view.canAsk && <ActionButton label={view.headline ? "Ask again" : "Ask the product owner why"} variant="plain" run={act("diagnose")} />;
  if (!view.headline) return ask ? <div className="actions">{ask}</div> : null;
  return (
    <Section title="Product owner">
      <div className="diagnosis">
        <p className="diagnosis-headline">{view.headline}</p>
        {view.summary && <p>{view.summary}</p>}
        {view.evidence.length > 0 && (
          <ul className="diagnosis-evidence">
            {view.evidence.map((e, i) => (
              <li key={i}>
                <span className="muted small">{e.source}</span>
                {e.unchecked && <span className="badge badge-bad">not found there</span>}
                <blockquote>{e.quote}</blockquote>
                {e.note && <span className="small">{e.note}</span>}
              </li>
            ))}
          </ul>
        )}
        {view.proposal && (
          <div>
            <p>
              <strong>Proposes: {view.proposal.label}.</strong> {view.proposal.why}
            </p>
            {view.proposal.details.map((d, i) => (
              <p key={i} className="small diagnosis-detail">
                {d}
              </p>
            ))}
          </div>
        )}
        {view.decision && <p className="muted small">{view.decision}</p>}
        {(view.canDecide || ask) && (
          <div className="actions">
            {view.canDecide && <ActionButton label="Accept" run={act("diagnosis/accept")} />}
            {view.canDecide && <ActionButton label="Refuse" variant="plain" run={act("diagnosis/refuse")} />}
            {ask}
          </div>
        )}
        {view.footer && <p className="muted small">{view.footer}</p>}
      </div>
    </Section>
  );
}
