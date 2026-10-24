"use client";

import { useState } from "react";
import { hubGet, hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { ActionButton, Badge, Banner, Section, TopBar } from "./ui.tsx";
import type { WorkerKey } from "../lib/types.ts";
import { joinCommands, workerKeyBadge } from "../lib/view.ts";

/** The worker machines' own keys: add a machine with a one-time join code, or shut one out. */
export function Machines() {
  const keys = usePoll<WorkerKey[]>("worker-keys", 5000);
  const [join, setJoin] = useState<{ commands: string[]; expiresAt: string }>();
  const [error, setError] = useState<string>();

  const add = async () => {
    setError(undefined);
    const version = await hubGet<{ sha256: string | null }>("version");
    const r = await hubPost<{ code: string; expiresAt: string }>("worker-keys/join-codes", {});
    if (!r.ok) return setError(r.error);
    setJoin({ commands: joinCommands(window.location.hostname, r.data.code, version.ok ? version.data.sha256 : undefined), expiresAt: r.data.expiresAt });
  };

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
              <pre className="mono small deploy-output">{join.commands.join("\n")}</pre>
              <button type="button" className="button button-plain" onClick={() => void navigator.clipboard?.writeText(join.commands.join("\n"))}>
                Copy
              </button>
            </>
          ) : (
            <button type="button" className="button button-primary" onClick={() => void add()}>
              Add a machine
            </button>
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
                  </div>
                  <Badge label={b.label} tone={b.tone} />
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
