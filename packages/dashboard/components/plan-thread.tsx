"use client";

import { useState } from "react";
import { Banner } from "./ui.tsx";
import { REPLY_COPY, timeAgo, type ReplyMode, type ThreadItem } from "../lib/view.ts";

/** A plan's conversation: your requirement and replies on the right, the Architect's on the left. */
export function PlanThread({ items }: { items: ThreadItem[] }) {
  return (
    <ol className="thread">
      {items.map((item, i) => (
        <li key={i} className={`bubble bubble-${item.who}`}>
          <span className="bubble-who">
            {item.who === "you" ? "You" : "Architect"} · {timeAgo(item.at)}
          </span>
          <ThreadBody item={item} />
        </li>
      ))}
    </ol>
  );
}

function ThreadBody({ item }: { item: ThreadItem }) {
  switch (item.kind) {
    case "requirement":
    case "reply":
      return <p className="prose">{item.text}</p>;
    case "questions":
      return (
        <>
          {item.context && <p className="prose muted">{item.context}</p>}
          <ol className="list">
            {item.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ol>
        </>
      );
    case "earlier-proposal":
      return (
        <details className="plan-task-more">
          <summary>Earlier plan ({item.tasks.length} tasks)</summary>
          <p className="prose small">{item.summary}</p>
          <ol className="list small">
            {item.tasks.map((t) => (
              <li key={t.key}>{t.title}</li>
            ))}
          </ol>
        </details>
      );
  }
}

/** Answer the Architect's questions, or ask for changes to its plan. */
export function ReplyBox({ mode, send }: { mode: ReplyMode; send: (message: string) => Promise<string | undefined> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const copy = REPLY_COPY[mode];
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    const problem = await send(text);
    setBusy(false);
    if (problem) setError(problem);
    else setText("");
  };
  return (
    <div className="reply-box">
      {error && <Banner tone="bad">{error}</Banner>}
      <textarea
        className="input textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={copy.placeholder}
        rows={copy.rows}
        aria-label={copy.label}
      />
      <button type="button" className={`button ${copy.primary ? "button-primary" : "button-plain"} button-wide`} disabled={busy || !text.trim()} onClick={submit}>
        {busy ? "Sending…" : copy.button}
      </button>
    </div>
  );
}
