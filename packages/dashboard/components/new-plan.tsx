"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { Banner, TopBar } from "./ui.tsx";
import type { Project } from "../lib/types.ts";

export function NewPlan({ project: initial }: { project?: string }) {
  const router = useRouter();
  const projects = usePoll<Project[]>("projects", 30_000);
  const [project, setProject] = useState(initial ?? "");
  const chosen = project || (projects.data?.length === 1 ? projects.data[0].id : "");
  const [requirement, setRequirement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const result = await hubPost<{ planId: string }>("plans", { requirement, project: chosen });
    if (result.ok) return router.push(`/plans/${result.data.planId}`);
    setError(result.error);
    setBusy(false);
  };

  return (
    <>
      <TopBar title="New plan" back={initial ? `/projects/${initial}` : "/"} />
      <main className="page">
        <p className="muted">
          Describe what you want built or changed. The Architect explores the project and proposes tasks; nothing starts until you approve.
        </p>
        {error && <Banner tone="bad">{error}</Banner>}
        {projects.data && projects.data.length === 0 && <Banner tone="waiting">Create a project first.</Banner>}
        {projects.data && projects.data.length > 1 && (
          <label className="field">
            <span className="field-label">Project</span>
            <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="" disabled>
                Choose a project
              </option>
              {projects.data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
          </label>
        )}
        <textarea
          className="input textarea"
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          placeholder="e.g. Add a dark mode toggle to the settings dialog and remember the choice"
          rows={8}
          autoFocus
        />
        <button type="button" className="button button-primary button-wide" disabled={busy || !requirement.trim() || !chosen} onClick={submit}>
          {busy ? "Sending…" : "Ask the Architect"}
        </button>
      </main>
    </>
  );
}
