"use client";

import { useState } from "react";
import { usePoll } from "./use-poll.ts";
import { Banner, Section, TopBar } from "./ui.tsx";
import { ModelSuggestions } from "./model-suggestions.tsx";
import type { Project, TrackRecordKey, TrackRecords } from "../lib/types.ts";
import { TRACK_RECORD_GROUPS, trackRecordGroupLabel, trackRecordLine, trackRecordsPath } from "../lib/view.ts";

/** How models, machines, desks, roles and projects have done with their jobs. */
export function TrackRecordsPage() {
  const [by, setBy] = useState<TrackRecordKey>("model");
  const [project, setProject] = useState("");
  const records = usePoll<TrackRecords>(trackRecordsPath(by, project || undefined), 60_000);
  const projects = usePoll<Project[]>("projects", 60_000);

  return (
    <>
      <TopBar title="Track records" back="/" />
      <main className="page">
        <p className="muted">
          What came of each job: the tasks each one finished (on the first try, or taking over from another), its builds&apos;
          QA and acceptance verdicts, and their cost; for models and projects also the plans made as the Architect and the
          acceptance checks made as the reviewer. Counted from when the Hub began recording jobs
          {records.data?.since ? ` (the oldest here: ${new Date(records.data.since).toLocaleString()})` : ""}.
        </p>
        <label className="field">
          <span className="field-label">By</span>
          <select className="input" value={by} onChange={(e) => setBy(e.target.value as TrackRecordKey)}>
            {TRACK_RECORD_GROUPS.map((g) => (
              <option key={g.by} value={g.by}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Project</span>
          <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
        <ModelSuggestions />
        {records.error && <Banner tone="bad">{records.error}</Banner>}
        <Section title={trackRecordGroupLabel(by)} count={records.data?.rows.length}>
          {records.data?.rows.length === 0 && <p className="muted">No jobs recorded yet.</p>}
          <div className="card-list">
            {records.data?.rows.map((r) => (
              <div key={r.key} className="row">
                <div className="row-main">
                  <span className="row-title mono">{r.key}</span>
                  <span className="row-sub">{trackRecordLine(r)}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </main>
    </>
  );
}
