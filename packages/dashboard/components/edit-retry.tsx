"use client";

import { useState } from "react";
import { hubAction } from "./use-poll.ts";
import { ActionButton, Section } from "./ui.tsx";
import type { Task } from "../lib/types.ts";
import { retryEditFromForm } from "../lib/view.ts";

/**
 * Correct a failed or cancelled task, then run it again: for a criterion that can't be met, or a
 * description that sent the agent the wrong way. The Hub keeps the old text in the history.
 */
export function EditRetry({ task, onClose }: { task: Task; onClose: () => void }) {
  const [description, setDescription] = useState(task.spec.description);
  const [criteria, setCriteria] = useState(task.spec.acceptanceCriteria.join("\n"));
  const edit = retryEditFromForm(task.spec, description, criteria);
  const changed = Object.keys(edit).length > 0;

  return (
    <Section title="Edit and retry">
      <label className="field">
        <span className="field-label">Description</span>
        <textarea className="input textarea" value={description} onChange={(e) => setDescription(e.target.value)} rows={8} />
      </label>
      <label className="field">
        <span className="field-label">Acceptance criteria, one per line</span>
        <textarea className="input textarea" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={Math.max(4, task.spec.acceptanceCriteria.length + 1)} />
      </label>
      <p className="muted small">The agent is told what you changed, and the task&apos;s history keeps the old text.</p>
      <div className="actions">
        <ActionButton
          label={changed ? "Retry with these changes" : "Retry as it is"}
          run={async () => {
            const err = await hubAction(`tasks/${task.spec.taskId}/retry`, edit);
            if (!err) onClose();
            return err;
          }}
        />
        <button type="button" className="button button-plain" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Section>
  );
}
