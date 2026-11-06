"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { hubPost } from "./hub-client.ts";
import { ActionButton } from "./ui.tsx";
import { deleteConfirmed } from "../lib/view.ts";

/** Deleting a project: out of the way, and only once its name is typed. The Hub says what stops it. */
export function DeleteProject({ id }: { id: string }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [force, setForce] = useState(false);
  return (
    <details>
      <summary className="small">Delete this project</summary>
      <p className="small">
        Deletes its folder on the Hub, with its tasks, plans, transcripts and screenshots. This can&apos;t be undone, and its tasks leave the track records. A GitHub repository and
        its open pull requests stay as they are.
      </p>
      <label className="field">
        <span className="field-label">
          Type <span className="mono">{id}</span> to confirm
        </span>
        <input className="input" autoComplete="off" autoCapitalize="none" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <label className="checkbox small">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Also delete its history, uncommitted changes, and commits no remote has
      </label>
      {deleteConfirmed(id, typed) && (
        <p>
          <ActionButton
            label="Delete project"
            variant="danger"
            run={async () => {
              const r = await hubPost(`projects/${id}/delete`, { force });
              if (r.ok) router.push("/");
              return r.ok ? undefined : r.error;
            }}
          />
        </p>
      )}
    </details>
  );
}
