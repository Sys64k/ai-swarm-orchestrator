"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { hubPost } from "./hub-client.ts";
import { Banner, TopBar } from "./ui.tsx";

export function NewPlan() {
  const router = useRouter();
  const [requirement, setRequirement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const result = await hubPost<{ planId: string }>("plans", { requirement });
    if (result.ok) return router.push(`/plans/${result.data.planId}`);
    setError(result.error);
    setBusy(false);
  };

  return (
    <>
      <TopBar title="New plan" back="/" />
      <main className="page">
        <p className="muted">
          Describe what you want built or changed. The Architect explores the project and proposes tasks; nothing starts until you approve.
        </p>
        {error && <Banner tone="bad">{error}</Banner>}
        <textarea
          className="input textarea"
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          placeholder="e.g. Add a dark mode toggle to the settings dialog and remember the choice"
          rows={8}
          autoFocus
        />
        <button type="button" className="button button-primary button-wide" disabled={busy || !requirement.trim()} onClick={submit}>
          {busy ? "Sending…" : "Ask the Architect"}
        </button>
      </main>
    </>
  );
}
