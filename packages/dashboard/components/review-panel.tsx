"use client";

import { hubAction, usePoll } from "./use-poll.ts";
import { ReplyBox } from "./plan-thread.tsx";
import { ActionButton, Badge, Banner, Section } from "./ui.tsx";
import type { ReviewChecks, TaskDiff } from "../lib/types.ts";
import { approveAction, checkBadge, checksSummary, diffSummary, fileStatusLabel, filesOpenByDefault, patchLines } from "../lib/view.ts";

/** Approve the task's pull request, or send it back with what should change. */
export function ReviewPanel({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { data: checks, error } = usePoll<ReviewChecks>(`tasks/${taskId}/checks`, 15_000);
  const approve = checks && approveAction(checks);
  const summary = checks && checksSummary(checks);
  const send = async (path: string, body: unknown) => {
    const err = await hubAction(`tasks/${taskId}/${path}`, body);
    onDone();
    return err;
  };

  return (
    <Section title="Your review">
      {error && !checks && <Banner tone="bad">Couldn't load the checks: {error}</Banner>}
      {summary && <p className={`small tone-${summary.tone}`}>{summary.text}</p>}
      {checks && checks.checks.length > 0 && (
        <ul className="checks">
          {checks.checks.map((c) => (
            <li key={c.name}>
              <Badge {...checkBadge(c.state)} />
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
              ) : (
                <span>{c.name}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {approve && (
        <div className="actions">
          <ActionButton label={approve.label} variant={approve.variant} confirm={approve.confirm} run={() => send("approve", { force: approve.force })} />
        </div>
      )}
      <ReplyBox mode="review" send={(message) => send("request-changes", { message })} />
    </Section>
  );
}

/** What the task changes, file by file; each file opens to its patch. */
export function ChangesView({ taskId, prUrl }: { taskId: string; prUrl?: string }) {
  const { data: diff, error } = usePoll<TaskDiff>(`tasks/${taskId}/diff`, 30_000);
  if (!diff) return error ? <Banner tone="bad">Couldn't load the changes: {error}</Banner> : <p className="muted">Loading the changes…</p>;
  if (diff.files.length === 0) return <p className="muted">This commit changes no files.</p>;

  return (
    <>
      <p className="muted small">
        {diffSummary(diff)} · <code>{diff.head.slice(0, 8)}</code>
      </p>
      {diff.truncated && (
        <p className="muted small">
          Some files are too big to show here
          {prUrl && (
            <>
              ; see them{" "}
              <a href={`${prUrl}/files`} target="_blank" rel="noreferrer">
                on GitHub
              </a>
            </>
          )}
          .
        </p>
      )}
      <div className="diff-files">
        {diff.files.map((f) => (
          <details key={f.path} className="diff-file" open={filesOpenByDefault(diff)}>
            <summary>
              <span className="diff-path mono">{f.path}</span>
              <span className="diff-stat small">
                {fileStatusLabel(f.status)}
                <span className="tone-good">+{f.additions}</span> <span className="tone-bad">−{f.deletions}</span>
              </span>
            </summary>
            {f.binary ? (
              <p className="muted small diff-note">Binary file</p>
            ) : f.patch ? (
              <pre className="diff">
                {patchLines(f).map((line, i) => (
                  <span key={i} className={`diff-line diff-${line.kind}`}>
                    {line.text || " "}
                  </span>
                ))}
              </pre>
            ) : (
              <p className="muted small diff-note">Too big to show here.</p>
            )}
          </details>
        ))}
      </div>
    </>
  );
}
