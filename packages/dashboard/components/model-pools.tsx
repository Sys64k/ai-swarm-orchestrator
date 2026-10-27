"use client";

import { useEffect, useState } from "react";
import { hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { ActionButton, Banner, Section } from "./ui.tsx";
import { ModelPicker } from "./model-picker.tsx";
import type { ChallengerRole, Models, RolePool, TuningView } from "../lib/types.ts";
import {
  candidatesBody,
  DEFAULT_TRIAL_BUDGET_USD,
  DEFAULT_TRIAL_SHARE_PERCENT,
  escalationChoices,
  MAX_TRIAL_SHARE_PERCENT,
  poolMemberLine,
  recentChanges,
  trialBody,
  trialLength,
} from "../lib/view.ts";

const ROLES: Array<{ role: ChallengerRole; label: string }> = [
  { role: "desks", label: "Desks (tasks start on these models)" },
  { role: "reviewer", label: "Reviewer (these models make the acceptance checks)" },
];

/** Each role's model pool: its own model and the models with a share of its work, auto-tuning, and the latest changes. */
export function ModelPools({ models }: { models: Models }) {
  const tuning = usePoll<TuningView>("tuning", 30_000);
  if (tuning.error) return <Banner tone="bad">{tuning.error}</Banner>;
  const data = tuning.data;
  if (!data) return null;
  const recent = recentChanges(data.log, 5);
  return (
    <Section title="Model pools">
      <p className="muted small">
        Models on trial take a share of a role&apos;s work, within a budget. With auto-tuning on, the Hub tries the models you
        queue one after another and, every few finished tasks, moves the shares toward the cheapest model that does the work well
        enough; one that comes to take more than the role&apos;s own model replaces it. Every change is logged here and notified.
      </p>
      {ROLES.map(({ role, label }) => (
        <PoolCard key={role} role={role} label={label} pool={data.roles[role]} models={models} onChanged={tuning.refresh} />
      ))}
      {recent.length > 0 && (
        <>
          <span className="muted small">Latest changes</span>
          {recent.map((e, i) => (
            <p key={i} className="muted small">
              {new Date(e.at).toLocaleString()} · {e.role}: {e.text}
            </p>
          ))}
        </>
      )}
    </Section>
  );
}

function PoolCard({ role, label, pool, models, onChanged }: { role: ChallengerRole; label: string; pool: RolePool; models: Models; onChanged: () => void }) {
  const choices = escalationChoices(models);
  const [model, setModel] = useState(choices[0]?.value ?? "");
  const [share, setShare] = useState(String(DEFAULT_TRIAL_SHARE_PERCENT));
  const [budget, setBudget] = useState(String(DEFAULT_TRIAL_BUDGET_USD[role]));
  const queued = pool.candidates.join(", ");
  const [candidates, setCandidates] = useState(queued);
  // The Hub takes candidates off the queue as it starts them: follow it.
  useEffect(() => setCandidates(queued), [queued]);
  const post = async (path: string, body: unknown) => {
    const r = await hubPost(path, body);
    if (!r.ok) return r.error;
    onChanged();
    return undefined;
  };
  return (
    <div className="card">
      <span className="row-title">{label}</span>
      <span className="row-sub">
        {pool.base ?? "no model"}: {Math.round(pool.baseShare * 100)}% (its own model)
      </span>
      {pool.members.map((m) => (
        <div key={m.model} className="row">
          <span className="row-sub">{poolMemberLine(m)}</span>
          <ActionButton label="End" variant="plain" run={() => post("models/challengers", { role, model: m.model, end: true })} />
        </div>
      ))}
      <ActionButton label={pool.auto ? "Turn auto-tuning off" : "Turn auto-tuning on"} variant="plain" run={() => post("tuning", { role, auto: !pool.auto })} />
      <label className="model-picker">
        <span className="muted small">Models to try next, in order (comma-separated)</span>
        <input className="input" value={candidates} onChange={(e) => setCandidates(e.target.value)} placeholder="openai/gpt-6.1-terra, anthropic/claude-sonnet-5-5" />
      </label>
      <ActionButton label="Save the queue" variant="plain" run={() => post("tuning", candidatesBody(role, candidates))} />
      <ModelPicker
        label="Or try one now"
        choices={choices}
        value={model}
        // Only remembered here; the trial starts with the button below.
        onChoose={async (m) => {
          setModel(m);
          return undefined;
        }}
      />
      <label className="model-picker">
        <span className="muted small">
          Share of the work (%){Number(share) > 0 ? `: it needs 10 ${role === "desks" ? "tasks" : "met verdicts"}, so ${trialLength(Number(share), 10)} pass` : ""}
        </span>
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
          return "error" in built ? built.error : post("models/challengers", built.body);
        }}
      />
    </div>
  );
}
