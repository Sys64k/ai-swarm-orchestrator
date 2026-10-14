import { safeNext } from "../../lib/auth.ts";

export const metadata = { title: "Sign in · ASO" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="page login">
      <div className="login-mark" aria-hidden>
        ◆
      </div>
      <h1 className="login-title">AI Swarm Orchestrator</h1>
      <p className="muted">
        Sign in with the ASO token. Run <code>aso token</code> on the Hub machine to see it.
      </p>
      {error && <div className="banner banner-bad">That token is not right.</div>}
      <form method="post" action="/api/session" className="login-form">
        <input type="hidden" name="next" value={safeNext(next)} />
        <input
          className="input"
          type="password"
          name="token"
          autoComplete="current-password"
          placeholder="ASO token"
          required
          autoFocus
        />
        <button type="submit" className="button button-primary button-wide">
          Sign in
        </button>
      </form>
    </main>
  );
}
