import { LinkSignIn } from "../../components/link-sign-in.tsx";
import { TokenInput } from "../../components/token-input.tsx";
import { safeNext } from "../../lib/auth.ts";

export const metadata = { title: "Sign in · Skynet" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string; error?: string; code?: string }> }) {
  const { next, error, code } = await searchParams;
  const length = process.env.ASO_TOKEN?.length;
  return (
    <main className="page login">
      <div className="login-mark" aria-hidden>
        ◆
      </div>
      <h1 className="login-title">Skynet</h1>
      {code && !error ? (
        <LinkSignIn code={code} next={safeNext(next)} />
      ) : (
        <>
          <p className="muted">
            Sign in with the ASO token, or open a sign-in link: <code>aso console-link</code> on the Hub machine, or
            &ldquo;Sign in another device&rdquo; in a signed-in console.
          </p>
          {error === "link" && (
            <div className="banner banner-bad">That sign-in link is used up or expired. Links work once, for 10 minutes.</div>
          )}
          {error && error !== "link" && (
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
        </>
      )}
    </main>
  );
}
