"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { hubPost } from "./hub-client.ts";
import { Banner, TopBar } from "./ui.tsx";
import { signInLink } from "../lib/auth.ts";

interface Link {
  url: string;
  svg: string;
  expiresAt: number;
}

/** Create a one-time sign-in link for another device, shown as a QR code to scan. */
export function SignInDevice() {
  const [link, setLink] = useState<Link>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    setError(undefined);
    setCopied(false);
    const result = await hubPost<{ code: string; expiresAt: string }>("sign-in-codes");
    if (!result.ok) return setError(result.error);
    const url = signInLink(window.location.origin, result.data.code);
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    setLink({ url, svg, expiresAt: Date.parse(result.data.expiresAt) });
  };

  const left = link ? Math.max(0, Math.round((link.expiresAt - now) / 1000)) : 0;
  const expired = link !== undefined && left === 0;

  return (
    <>
      <TopBar title="Sign in another device" back="/" />
      <main className="page">
        <p className="muted">
          Scan the code with the other device&apos;s camera, or send it the link. It signs that device in once; the link
          stops working after it&apos;s used or after 10 minutes.
        </p>
        {error && <Banner tone="bad">{error}</Banner>}
        {link && !expired ? (
          <div className="qr-card">
            <div className="qr" dangerouslySetInnerHTML={{ __html: link.svg }} />
            <p className="muted small">
              Works for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </p>
            <div className="actions">
              <button
                type="button"
                className="button button-plain"
                onClick={async () => {
                  await navigator.clipboard?.writeText(link.url);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
              {typeof navigator !== "undefined" && "share" in navigator && (
                <button type="button" className="button button-plain" onClick={() => void navigator.share({ url: link.url, title: "Sign in to ASO" }).catch(() => undefined)}>
                  Share
                </button>
              )}
            </div>
          </div>
        ) : (
          <button type="button" className="button button-primary button-wide" onClick={create}>
            {expired ? "Create a new link" : "Create sign-in link"}
          </button>
        )}
      </main>
    </>
  );
}
