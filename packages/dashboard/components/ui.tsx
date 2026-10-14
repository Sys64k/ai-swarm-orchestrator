"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Tone } from "../lib/view.ts";

export function Badge({ label, tone }: { label: string; tone: Tone }) {
  return <span className={`badge badge-${tone}`}>{label}</span>;
}

/** Sticky header: back link on sub-pages, title, optional right-hand slot. */
export function TopBar({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      {back ? (
        <Link href={back} className="topbar-back" aria-label="Back">
          ‹
        </Link>
      ) : (
        <span className="topbar-logo" aria-hidden>
          ◆
        </span>
      )}
      <h1 className="topbar-title">{title}</h1>
      {right}
    </header>
  );
}

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="section">
      <h2 className="section-title">
        {title}
        {count !== undefined && <span className="section-count">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

/** A tappable row: title, secondary line, badge on the right. */
export function Row({ href, title, sub, badge }: { href: string; title: string; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <Link href={href} className="row">
      <span className="row-main">
        <span className="row-title">{title}</span>
        {sub && <span className="row-sub">{sub}</span>}
      </span>
      {badge}
      <span className="row-chevron" aria-hidden>
        ›
      </span>
    </Link>
  );
}

/** Placeholder page while a record loads, or when it can't be loaded. */
export function LoadingPage({ title, back, error }: { title: string; back: string; error?: string }) {
  return (
    <>
      <TopBar title={title} back={back} />
      <main className="page">{error ? <Banner tone="bad">{error}</Banner> : <p className="muted">Loading…</p>}</main>
    </>
  );
}

export function Banner({ tone, children }: { tone: "bad" | "waiting"; children: ReactNode }) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}

/** A button that runs an async action, optionally after a confirmation, and shows its error. */
export function ActionButton({
  label,
  run,
  confirm,
  variant = "primary",
}: {
  label: string;
  run: () => Promise<string | undefined>;
  confirm?: string;
  variant?: "primary" | "danger" | "plain";
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span className="action">
      <button
        type="button"
        className={`button button-${variant}`}
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(await run());
          setBusy(false);
        }}
      >
        {busy ? "…" : label}
      </button>
      {error && <span className="action-error">{error}</span>}
    </span>
  );
}
