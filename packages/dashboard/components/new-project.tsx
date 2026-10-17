"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { Banner, TopBar } from "./ui.tsx";
import type { Health, Project } from "../lib/types.ts";
import { projectNameProblem } from "../lib/view.ts";

export function NewProject() {
  const router = useRouter();
  const health = usePoll<Health>("health", 60_000);
  const [name, setName] = useState("");
  const [github, setGithub] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const problem = projectNameProblem(name);
  const root = health.data?.projectsRoot;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const result = await hubPost<Project>("projects", { name, ...(github.trim() ? { github: github.trim() } : {}) });
    if (result.ok) return router.push(`/projects/${result.data.id}`);
    setError(result.error);
    setBusy(false);
  };

  return (
    <>
      <TopBar title="New project" back="/" />
      <main className="page">
        <p className="muted">
          A new git repository{root ? " in the projects folder" : ""}: empty, or connected to a GitHub repository. The
          Architect plans its first tasks from your description, so it can start from nothing.
        </p>
        {error && <Banner tone="bad">{error}</Banner>}
        <input
          className="input mono"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
          placeholder="my-app"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          aria-describedby="project-hint"
        />
        <p id="project-hint" className={`small ${name && problem ? "action-error" : "muted"}`}>
          {name && problem ? problem : root ? <span className="mono">{`${root}/${name || "…"}`}</span> : "Lowercase letters, digits, - and _."}
        </p>
        <label className="small muted" htmlFor="project-github">
          GitHub repository (optional)
        </label>
        <input
          id="project-github"
          className="input mono"
          value={github}
          onChange={(e) => setGithub(e.target.value)}
          placeholder="owner/repo"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby="github-hint"
        />
        <p id="github-hint" className="small muted">
          Its code and pull requests. Create the repository on GitHub first and add it to the Hub&apos;s token; an empty one gets the first commit.
        </p>
        <button type="button" className="button button-primary button-wide" disabled={busy || !!problem} onClick={submit}>
          {busy ? "Creating…" : "Create project"}
        </button>
      </main>
    </>
  );
}
