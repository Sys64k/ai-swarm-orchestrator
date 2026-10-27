"use client";

import { useEffect, useState } from "react";
import { hubPost } from "./hub-client.ts";
import { ActionButton, Section } from "./ui.tsx";
import { ModelPicker } from "./model-picker.tsx";
import type { Desks, Models } from "../lib/types.ts";
import {
  ESCALATION_RESET_BODY,
  escalationBody,
  escalationChoices,
  escalationDraft,
  escalationSummary,
  MAX_JUNIOR_TRIES,
  nextLadderStep,
  type EscalationBody,
} from "../lib/view.ts";

/** Where failing tasks move: the ladder of stronger models (weakest first) and the tries on a desk's model before it. */
export function EscalationEditor({ models, desks, onSaved }: { models: Models; desks?: Desks; onSaved: () => void }) {
  const summary = escalationSummary(desks);
  const [draft, setDraft] = useState(() => escalationDraft(desks));
  const [editing, setEditing] = useState(false);
  // Follow the Hub until the user starts editing.
  useEffect(() => {
    if (!editing) setDraft(escalationDraft(desks));
  }, [desks, editing]);
  if (summary === undefined) return null;

  const choices = escalationChoices(models, desks);
  const change = (next: Partial<typeof draft>) => {
    setEditing(true);
    setDraft({ ...draft, ...next });
  };
  const next = nextLadderStep(choices, draft.ladder);
  const save = async (body: EscalationBody) => {
    const r = await hubPost("models/escalation", body);
    if (!r.ok) return r.error;
    setEditing(false);
    onSaved();
    return undefined;
  };

  return (
    <Section title="Failed tasks (escalation)">
      <p className="muted small">
        A task that keeps failing on its desk&apos;s model moves up a ladder of stronger models, one step per further try.
        The track records show what each model finished, and at what cost.
      </p>
      <p className="small">{summary}</p>
      <label className="model-picker">
        <span className="muted small">Tries on a desk&apos;s model first (0: straight to the ladder)</span>
        <input className="input" type="number" min={0} max={MAX_JUNIOR_TRIES} value={draft.juniorTries} onChange={(e) => change({ juniorTries: e.target.value })} />
      </label>
      {draft.ladder.map((step, i) => (
        <div key={i} className="row">
          <ModelPicker
            label={`Step ${i + 1}`}
            choices={choices}
            value={step}
            onChoose={async (model) => {
              change({ ladder: draft.ladder.map((s, j) => (j === i ? model : s)) });
              return undefined;
            }}
          />
          <button type="button" className="button button-plain" onClick={() => change({ ladder: draft.ladder.filter((_, j) => j !== i) })}>
            Remove
          </button>
        </div>
      ))}
      <div className="row">
        {next && (
          <button type="button" className="button button-plain" onClick={() => change({ ladder: [...draft.ladder, next] })}>
            Add a step
          </button>
        )}
        <ActionButton
          label="Save"
          run={async () => {
            const built = escalationBody(draft.ladder, draft.juniorTries);
            return "error" in built ? built.error : save(built.body);
          }}
        />
        <ActionButton label="Back to the start settings" variant="plain" run={() => save(ESCALATION_RESET_BODY)} />
      </div>
    </Section>
  );
}
