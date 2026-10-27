"use client";

import { hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { ActionButton, Banner, Section } from "./ui.tsx";
import type { ModelSuggestions as Suggestions } from "../lib/types.ts";
import { suggestionNote, suggestionRequests, suggestionTitle } from "../lib/view.ts";

/** Which model each role would do as well on for less, or clearly better on, with a button to switch. */
export function ModelSuggestions() {
  const data = usePoll<Suggestions>("model-suggestions", 300_000);
  if (data.error) return <Banner tone="bad">{data.error}</Banner>;
  if (!data.data) return null;
  const { suggestions, notes, since } = data.data;
  return (
    <Section title="Suggestions" count={suggestions.length}>
      <p className="muted small">
        From the jobs since {new Date(since).toLocaleDateString()}: a model that does about as well for clearly less, or does
        clearly better. Nothing changes until you switch.
      </p>
      <div className="card-list">
        {suggestions.map((s) => {
          const requests = suggestionRequests(s);
          return (
            <div key={s.role} className="row">
              <div className="row-main">
                <span className="row-title">{suggestionTitle(s)}</span>
                <span className="row-sub">{s.reason}</span>
              </div>
              {requests.length > 0 ? (
                <ActionButton
                  label="Switch"
                  confirm={`${suggestionTitle(s)}?`}
                  run={async () => {
                    for (const r of requests) {
                      const res = await hubPost(r.path, r.body);
                      if (!res.ok) return res.error;
                    }
                    data.refresh();
                    return undefined;
                  }}
                />
              ) : (
                <span className="muted small">No provider offers it now</span>
              )}
            </div>
          );
        })}
      </div>
      {notes.map((n) => (
        <p key={n.role} className="muted small">
          {suggestionNote(n)}
        </p>
      ))}
    </Section>
  );
}
