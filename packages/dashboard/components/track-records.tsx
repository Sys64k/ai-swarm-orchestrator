"use client";

import { useState } from "react";
import { usePoll } from "./use-poll.ts";
import { Banner, Section, TopBar } from "./ui.tsx";
import { ModelSuggestions } from "./model-suggestions.tsx";
import type { ProductOwnerRecord, Project, TrackRecordKey, TrackRecords } from "../lib/types.ts";
import { productOwnerLines, productOwnerPath, sinceDaysAgo, TASK_ROLES, TRACK_RECORD_GROUPS, TRACK_RECORD_PERIODS, trackRecordGroupLabel, trackRecordLine, trackRecordsPath } from "../lib/view.ts";

/** How models, machines, desks, roles and projects have done with their jobs. */
export function TrackRecordsPage() {
  const [by, setBy] = useState<TrackRecordKey>("model");
  const [project, setProject] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState("");
  const [days, setDays] = useState(0);
  const since = sinceDaysAgo(days, new Date());
  const records = usePoll<TrackRecords>(trackRecordsPath(by, { project, role, model, since }), 60_000);
  // Every model with a record, whatever the other filters, to choose from.
  const models = usePoll<TrackRecords>(trackRecordsPath("model"), 60_000);
  const projects = usePoll<Project[]>("projects", 60_000);
  const owner = usePoll<ProductOwnerRecord>(productOwnerPath({ project, since }), 60_000);
  const ownerLines = owner.data ? productOwnerLines(owner.data) : [];
  const filtered = !!(project || role || model || days);

  return (
    <>
      <TopBar title="Track records" back="/" />
      <main className="page page-wide columns columns-filters">
        <div className="column column-sticky">
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
          <label className="field">
            <span className="field-label">Model</span>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">All models</option>
              {models.data?.rows.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.key}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Role</span>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All roles</option>
              {TASK_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Period</span>
            <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {TRACK_RECORD_PERIODS.map((p) => (
                <option key={p.days} value={p.days}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {model && <p className="muted small">Only {model}&apos;s work: its builds, the tasks it started and finished, its plans and acceptance checks. QA runs have no model.</p>}
        </div>
        <div className="column">
          <ModelSuggestions />
          {records.error && <Banner tone="bad">{records.error}</Banner>}
          <Section title={trackRecordGroupLabel(by)} count={records.data?.rows.length}>
            {records.data?.rows.length === 0 && <p className="muted">{filtered ? "Nothing recorded with these filters." : "No jobs recorded yet."}</p>}
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
          {ownerLines.length > 0 && (
            <Section title="Product owner">
              <p className="muted small">What it read of failed tasks, what you did with its proposals, and whether the retries you accepted worked.</p>
              <div className="card-list">
                {ownerLines.map((l) => (
                  <div key={l.label} className="row">
                    <div className="row-main">
                      <span className="row-title">{l.label}</span>
                      <span className="row-sub">{l.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>
      </main>
    </>
  );
}
