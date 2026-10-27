"use client";

import { useState } from "react";
import { Banner } from "./ui.tsx";
import { choiceGroups, type DeskModelChoice } from "../lib/view.ts";

/** A model picker: choices grouped by provider; `value` undefined shows "Mixed". `onChoose` returns an error to show, if any. */
export function ModelPicker({ label, choices, value, onChoose }: { label: string; choices: DeskModelChoice[]; value?: string; onChoose: (model: string) => Promise<string | undefined> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <label className="model-picker">
      <span className="muted small">{label}</span>
      <select
        className="input"
        value={value ?? ""}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          setError(await onChoose(e.target.value));
          setBusy(false);
        }}
      >
        {value === undefined && <option value="">Mixed</option>}
        {choiceGroups(choices).map(({ group, choices: inGroup }) => {
          const options = inGroup.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ));
          return group ? (
            <optgroup key={group} label={group}>
              {options}
            </optgroup>
          ) : (
            options
          );
        })}
      </select>
      {error && <Banner tone="bad">{error}</Banner>}
    </label>
  );
}
