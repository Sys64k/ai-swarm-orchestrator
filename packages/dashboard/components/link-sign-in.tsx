"use client";

import { useEffect, useRef } from "react";

/**
 * Signs in with a sign-in link's code as soon as the page opens. It posts from the page rather
 * than signing in on the link's GET, so chat apps that preview a link can't use the code up.
 */
export function LinkSignIn({ code, next }: { code: string; next: string }) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.requestSubmit();
  }, []);
  return (
    <form ref={form} method="post" action="/api/session" className="login-form">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="next" value={next} />
      <p className="muted">Signing you in…</p>
      <button type="submit" className="button button-primary button-wide">
        Sign in on this device
      </button>
    </form>
  );
}
