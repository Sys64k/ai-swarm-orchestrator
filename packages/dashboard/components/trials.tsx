"use client";

import { useState } from "react";
import { hubPost } from "./hub-client.ts";
import { ActionButton, Section } from "./ui.tsx";
import { ModelPicker } from "./model-picker.tsx";
import type { ChallengerRole, Desks, Models } from "../lib/types.ts";
import { DEFAULT_TRIAL_BUDGET_USD, DEFAULT_TRIAL_SHARE_PERCENT, escalationChoices, MAX_TRIAL_SHARE_PERCENT, trialBody, trialSummary } from "../lib/view.ts";

const ROLES: Array<{ role: ChallengerRole; label: string }> = [
  { role: "desks", label: "Desks (tasks start on it)" },
  { role: "reviewer", label: "Reviewer (it makes the acceptance checks)" },
];

/** Try a model for the desks or the reviewer on a share of the work, until the suggestions can compare it. */
export function Trials({ models, desks, onChanged }: { models: Models; desks?: Desks; onChanged: () => void }) {
  if (desks?.challengers === undefined) return null; // an older Hub
  return (
    <Section title="Trials">
      <p className="muted small">
        A model on trial takes a share of a role&apos;s work, within a budget, until the track records have enough data to
        compare it (see Suggestions on Track records). It ends by itself then.
      </p>
      {ROLES.map(({ role, label }) => (
        <TrialRow key={role} role={role} label={label} models={models} desks={desks} onChanged={onChanged} />
      ))}
    </Section>
  );
}

function TrialRow({ role, label, models, desks, onChanged }: { role: ChallengerRole; label: string; models: Models; desks: Desks; onChanged: () => void }) {
  const trial = desks.challengers?.[role];
  const choices = escalationChoices(models);
  const [model, setModel] = useState(choices[0]?.value ?? "");
  const [share, setShare] = useState(String(DEFAULT_TRIAL_SHARE_PERCENT));
  const [budget, setBudget] = useState(String(DEFAULT_TRIAL_BUDGET_USD));
  const post = async (body: unknown) => {
    const r = await hubPost("models/challengers", body);
    if (!r.ok) return r.error;
    onChanged();
    return undefined;
  };
  if (trial) {
    return (
      <div className="row">
        <div className="row-main">
          <span className="row-title">{label}</span>
          <span className="row-sub">{trialSummary(role, trial)}</span>
        </div>
        <ActionButton label="End" variant="plain" run={() => post({ role, model: "none" })} />
      </div>
    );
  }
  return (
    <div className="card">
      <span className="row-title">{label}</span>
      <ModelPicker
        label="Model to try"
        choices={choices}
        value={model}
        // Only remembered here; the trial starts with the button below.
        onChoose={async (m) => {
          setModel(m);
          return undefined;
        }}
      />
      <label className="model-picker">
        <span className="muted small">Share of the work (%)</span>
        <input className="input" type="number" min={1} max={MAX_TRIAL_SHARE_PERCENT} value={share} onChange={(e) => setShare(e.target.value)} />
      </label>
      <label className="model-picker">
        <span className="muted small">Budget (USD)</span>
        <input className="input" type="number" min={0.5} step={0.5} value={budget} onChange={(e) => setBudget(e.target.value)} />
      </label>
      <ActionButton
        label="Start the trial"
        run={async () => {
          const built = trialBody(role, model, share, budget);
          return "error" in built ? built.error : post(built.body);
        }}
      />
    </div>
  );
}
