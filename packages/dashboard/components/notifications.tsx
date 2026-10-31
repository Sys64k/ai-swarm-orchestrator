"use client";

import { useEffect, useState } from "react";
import { hubGet, hubPost } from "./hub-client.ts";
import { usePoll } from "./use-poll.ts";
import { Badge, Banner, Row, Section, TopBar } from "./ui.tsx";
import { detectPushEnvironment, enablePush, pushSetup, type PushSetup } from "../lib/push.ts";
import type { Notices } from "../lib/types.ts";
import { noticeRows } from "../lib/view.ts";

type Status = { setup: PushSetup; subscription: PushSubscription | null; on: boolean };

/** The service worker that shows notifications (see public/sw.js). */
async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}

async function readStatus(): Promise<Status> {
  const setup = pushSetup(
    detectPushEnvironment({
      isSecureContext: window.isSecureContext,
      hasServiceWorker: "serviceWorker" in navigator,
      hasPushManager: "PushManager" in window,
      notificationPermission: "Notification" in window ? Notification.permission : undefined,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      standalone: window.matchMedia("(display-mode: standalone)").matches,
    }),
  );
  if (setup.kind !== "ready") return { setup, subscription: null, on: false };
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) return { setup, subscription, on: false };
  const check = await hubPost<{ subscribed: boolean }>("push/subscriptions/check", { endpoint: subscription.endpoint });
  return { setup, subscription, on: check.ok && check.data.subscribed };
}

/** Turn notifications on or off for this device, and send a test. */
export function Notifications() {
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  useEffect(() => {
    readStatus().then(setStatus, (err: Error) => setError(err.message));
  }, []);

  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const problem = await action();
      if (problem) setError(problem);
    } catch (err) {
      setError((err as Error).message);
    }
    setStatus(await readStatus().catch(() => status));
    setBusy(false);
  };

  const turnOn = () =>
    run(() =>
      enablePush({
        requestPermission: () => Notification.requestPermission(),
        hubKey: async () => {
          const r = await hubGet<{ publicKey: string }>("push");
          return r.ok ? { ok: true, key: r.data.publicKey } : r;
        },
        pushManager: async () => (await registration()).pushManager,
        save: async (subscription) => {
          const r = await hubPost("push/subscriptions", subscription);
          return r.ok ? undefined : r.error;
        },
      }),
    );

  const turnOff = () =>
    run(async () => {
      const sub = status?.subscription;
      if (!sub) return undefined;
      const removed = await hubPost("push/subscriptions/delete", { endpoint: sub.endpoint });
      await sub.unsubscribe();
      return removed.ok ? undefined : removed.error;
    });

  const test = () =>
    run(async () => {
      const result = await hubPost("push/test", { endpoint: status?.subscription?.endpoint });
      if (!result.ok) return result.error;
      setNote("Sent. It should arrive within a few seconds.");
      return undefined;
    });

  return (
    <>
      <TopBar title="Notifications" back="/" />
      <main className="page">
        <NoticeList />
        <h2 className="section-title">On this device</h2>
        <p className="muted">
          Get each of these as a notification on this device too: a plan ready for your approval, a task that fails or keeps
          coming back, a provider on hold, a worker machine gone, a failed Hub update, the day&apos;s spending. Tapping it opens
          the page it is about.
        </p>
        {error && <Banner tone="bad">{error}</Banner>}
        {!status && !error && <p className="muted">Checking this device…</p>}
        {status && <SetupHint setup={status.setup} />}
        {status?.setup.kind === "ready" &&
          (status.on ? (
            <>
              <p className="notice-on">
                <span className="badge badge-good">On</span> This device gets notifications.
              </p>
              <div className="actions">
                <button type="button" className="button button-primary" disabled={busy} onClick={test}>
                  Send a test
                </button>
                <button type="button" className="button button-plain" disabled={busy} onClick={turnOff}>
                  Turn off
                </button>
              </div>
              {note && <p className="muted small">{note}</p>}
            </>
          ) : (
            <button type="button" className="button button-primary button-wide" disabled={busy} onClick={turnOn}>
              {busy ? "…" : "Turn on notifications"}
            </button>
          ))}
      </main>
    </>
  );
}

/** What the Hub has told you about, newest first, the unread ones marked New. */
function NoticeList() {
  const list = usePoll<Notices>("notices", 10_000);
  const [error, setError] = useState<string>();
  if (list.error) return <Banner tone="bad">Couldn&apos;t load the notices: {list.error}</Banner>;
  if (!list.data) return <p className="muted">Loading…</p>;
  const rows = noticeRows(list.data);
  const markRead = async () => {
    const r = await hubPost("notices/read", { upTo: rows[0].id });
    setError(r.ok ? undefined : r.error);
    list.refresh();
  };
  return (
    <Section title="Notices" count={list.data.unread || undefined}>
      {error && <Banner tone="bad">{error}</Banner>}
      {rows.length === 0 ? (
        <p className="muted">Nothing yet. The Hub lists here what it tells you about.</p>
      ) : (
        <div className="card-list">
          {rows.map((r) => (
            <Row key={r.id} href={r.href} title={r.title} sub={r.sub} badge={r.unread ? <Badge label="New" tone="waiting" /> : undefined} />
          ))}
        </div>
      )}
      {list.data.unread > 0 && (
        <div className="actions">
          <button type="button" className="button button-plain" onClick={markRead}>
            Mark all read
          </button>
        </div>
      )}
    </Section>
  );
}

function SetupHint({ setup }: { setup: PushSetup }) {
  switch (setup.kind) {
    case "ready":
      return null;
    case "needs-https":
      return (
        <Banner tone="waiting">
          Browsers only allow notifications over https. Open the console at its https address (for example through Tailscale:
          run <code>aso console-link</code> on the Hub) and turn them on there.
        </Banner>
      );
    case "needs-install":
      return (
        <Banner tone="waiting">
          On iPhone and iPad, notifications work only for the console added to the home screen: tap Share, then “Add to Home
          Screen”, open ASO from there and come back to this page.
        </Banner>
      );
    case "blocked":
      return (
        <Banner tone="bad">
          Notifications are blocked for this site. Allow them in the browser&apos;s site settings (the icon left of the address),
          then reload this page.
        </Banner>
      );
    case "unsupported":
      return <Banner tone="waiting">This browser doesn&apos;t support push notifications.</Banner>;
  }
}
