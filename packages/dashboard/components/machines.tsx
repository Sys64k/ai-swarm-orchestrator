"use client";

import { useState } from "react";
import { hubGet, hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { ActionButton, Badge, Banner, Section, TopBar } from "./ui.tsx";
import type { Project, WorkerKey } from "../lib/types.ts";
import { EMPTY_INVITE, inviteBody, inviteCommand, workerKeyBadge, workerKeyRecord, workerKeyScope, type InviteForm } from "../lib/view.ts";

/** The worker machines' own keys: add a machine with a one-time join code, or shut one out. */
export function Machines() {
  const keys = usePoll<WorkerKey[]>("worker-keys", 5000);
  const projects = usePoll<Project[]>("projects", 30_000);
  const [join, setJoin] = useState<{ command: string; expiresAt: string }>();
  const [error, setError] = useState<string>();
  // The form keeps its choices after an invite, for inviting the next machine alike.
  const [form, setForm] = useState<InviteForm>(EMPTY_INVITE);

  const add = async () => {
    setError(undefined);
    const built = inviteBody(form);
    if ("error" in built) return setError(built.error);
    const version = await hubGet<{ sha256: string | null }>("version");
    const r = await hubPost<{ code: string; expiresAt: string; gatewayUrl?: string }>("worker-keys/join-codes", built.body);
    if (!r.ok) return setError(r.error);
    const line = inviteCommand({ ...r.data, internet: form.internet, hostname: window.location.hostname, sha256: version.ok ? version.data.sha256 : undefined });
    if ("error" in line) return setError(line.error);
    setJoin({ command: line.command, expiresAt: r.data.expiresAt });
  };
  const toggleProject = (id: string) =>
    setForm({ ...form, projects: form.projects.includes(id) ? form.projects.filter((p) => p !== id) : [...form.projects, id] });

  return (
    <>
      <TopBar title="Worker machines" back="/" />
      <main className="page">
        <p className="muted">
          Each machine joins with its own key. A key lets it take jobs and use the projects&apos; Git, nothing else, and
          revoking it shuts that machine out at once. Away from this network, put the machines on a private network such as
          Tailscale.
        </p>
        {(error ?? keys.error) && <Banner tone="bad">{error ?? keys.error}</Banner>}

        <Section title="Add a machine">
          {join ? (
            <>
              <p className="muted small">On the new machine (the code works once, for 30 minutes):</p>
              <pre className="mono small deploy-output">{join.command}</pre>
              <button type="button" className="button button-plain" onClick={() => void navigator.clipboard?.writeText(join.command)}>
                Copy
              </button>
            </>
          ) : (
            <>
              <label className="checkbox small">
                <input type="checkbox" checked={form.internet} onChange={(e) => setForm({ ...form, internet: e.target.checked })} /> It joins from
                the internet, through the worker gateway (not this network or your tailnet)
              </label>
              <label className="checkbox small">
                <input type="checkbox" checked={form.untrusted} onChange={(e) => setForm({ ...form, untrusted: e.target.checked })} /> Someone
                else&apos;s machine: it only builds, and one of yours tests its work
              </label>
              {projects.data && projects.data.length > 1 && (
                <div className="field">
                  <span className="field-label">Projects it may work on (none ticked: all)</span>
                  {projects.data.map((p) => (
                    <label key={p.id} className="checkbox small">
                      <input type="checkbox" checked={form.projects.includes(p.id)} onChange={() => toggleProject(p.id)} /> {p.id}
                    </label>
                  ))}
                </div>
              )}
              <label className="field">
                <span className="field-label">Model budget in dollars (optional)</span>
                <input className="input" inputMode="decimal" placeholder="e.g. 10" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Name (optional; default: its hostname)</span>
                <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </label>
              <button type="button" className="button button-primary" onClick={() => void add()}>
                Add a machine
              </button>
            </>
          )}
        </Section>

        <Section title="Keys" count={keys.data?.length}>
          {keys.data?.length === 0 && <p className="muted">No machine has its own key yet. Workers that use the Hub&apos;s main token still work.</p>}
          <div className="card-list">
            {keys.data?.map((k) => {
              const b = workerKeyBadge(k);
              return (
                <div key={k.id} className="row">
                  <div>
                    <div>{k.name}</div>
                    <div className="muted small">
                      {k.id}
                      {b.detail ? ` · ${b.detail}` : ""}
                    </div>
                    <div className="muted small">{workerKeyScope(k)}</div>
                    <div className="muted small">{workerKeyRecord(k.track)}</div>
                  </div>
                  <Badge label={b.label} tone={b.tone} />
                  {!k.revokedAt && (
                    <ActionButton
                      label={k.trusted === false ? "Trust" : "Untrust"}
                      variant="plain"
                      confirm={
                        k.trusted === false
                          ? `Trust ${k.name}? Its machine will also run QA on others' work.`
                          : `Untrust ${k.name}? Its machine then only builds, and a trusted machine tests its work.`
                      }
                      run={async () => {
                        const r = await hubPost(`worker-keys/${k.id}`, { trusted: k.trusted === false });
                        if (r.ok) keys.refresh();
                        return r.ok ? undefined : r.error;
                      }}
                    />
                  )}
                  {!k.revokedAt && (
                    <ActionButton
                      label="Revoke"
                      variant="danger"
                      confirm={`Revoke ${k.name}'s key? It is disconnected now and can't come back without joining again.`}
                      run={async () => {
                        const r = await hubPost(`worker-keys/${k.id}/revoke`);
                        if (r.ok) keys.refresh();
                        return r.ok ? undefined : r.error;
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      </main>
    </>
  );
}
