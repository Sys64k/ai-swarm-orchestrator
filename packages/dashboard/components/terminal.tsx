"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hubGet } from "./hub-client.ts";
import { previewBody, terminalLines, type TerminalLine } from "../lib/view.ts";
import type { TranscriptEntry, TranscriptPage } from "../lib/types.ts";

/** Lines of output shown before "show more". */
const BODY_PREVIEW_LINES = 12;

/**
 * Live view of a transcript (`source` is its Hub path): polls for new entries only (`?after=`),
 * keeps them in order, and follows the bottom unless the reader scrolled up.
 */
export function Terminal({ source, live }: { source: string; live: boolean }) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string>();
  const [showQuiet, setShowQuiet] = useState(false);
  const last = useRef(-1);
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (document.visibilityState !== "visible" && live) {
        timer = setTimeout(load, 2000);
        return;
      }
      const result = await hubGet<TranscriptPage>(`${source}?after=${last.current}`);
      if (!result.ok) setError(result.error);
      else {
        setError(undefined);
        const fresh = result.data.entries;
        if (!stopped && fresh.length) {
          last.current = fresh.at(-1)!.seq;
          setEntries((prev) => [...prev, ...fresh]);
        }
      }
      // Poll while work is going on. When it stops, `live` changes and this effect reads once more.
      if (!stopped && live) timer = setTimeout(load, 2000);
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [source, live]);

  useEffect(() => {
    const onScroll = () => {
      follow.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  const lines = useMemo(() => terminalLines(entries, { showQuiet }), [entries, showQuiet]);

  return (
    <div className="terminal">
      <div className="terminal-tools">
        <label>
          <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} /> show file contents
        </label>
        {live && <span className="terminal-live">● live</span>}
      </div>
      {lines.length === 0 && <p className="muted">Nothing yet.</p>}
      {lines.map((line) => (
        <Line key={line.seq} line={line} />
      ))}
      {error && <p className="action-error">Could not load: {error}</p>}
      <div ref={bottom} />
    </div>
  );
}

function Line({ line }: { line: TerminalLine }) {
  const [open, setOpen] = useState(false);
  const body = previewBody(line.body, open, BODY_PREVIEW_LINES);
  return (
    <div className={`tline tline-${line.style}`}>
      <div className="tline-text">{line.text}</div>
      {body.text && (
        <>
          {(body.truncated || open) && body.lines > BODY_PREVIEW_LINES && (
            <button type="button" className="tline-more" onClick={() => setOpen(!open)}>
              {open ? "show less" : `show all ${body.lines} lines`}
            </button>
          )}
          <pre className="tline-body">{body.text}</pre>
        </>
      )}
    </div>
  );
}
