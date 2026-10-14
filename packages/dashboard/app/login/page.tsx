import { TokenInput } from "../../components/token-input.tsx";
import { safeNext } from "../../lib/auth.ts";

export const metadata = { title: "Sign in · ASO" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  const length = process.env.ASO_TOKEN?.length;
  return (
    <main className="page login">
      <div className="login-mark" aria-hidden>
        ◆
      </div>
      <h1 className="login-title">AI Swarm Orchestrator</h1>
      <p className="muted">
        Sign in with the ASO token. Run <code>aso token</code> on the Hub machine to see it.
      </p>
      {error && (
        <div className="banner banner-bad">
          That token doesn&apos;t match. It starts with <code>aso_</code>
          {length ? ` and is ${length} characters long` : ""}; tap Show to check what you entered.
        </div>
      )}
      <form method="post" action="/api/session" className="login-form">
        <input type="hidden" name="next" value={safeNext(next)} />
        <TokenInput />
        <button type="submit" className="button button-primary button-wide">
          Sign in
        </button>
      </form>
    </main>
  );
}
