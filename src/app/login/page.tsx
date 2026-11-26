import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { isHosted } from "@/server/mode";
import { sessionUserId } from "@/server/hosted/app";
import { sendSignInLink } from "../hosted-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

const ERRORS: Record<string, string> = {
  invalid_email: "That doesn't look like an email address.",
  not_invited: "This email isn't on the list yet. Ask whoever sent you the link to add it.",
  send_failed: "We couldn't send the email just now. Try again in a minute.",
  link: "That sign-in link has expired or was opened in another browser. Send a new one.",
};

// Hosted mode: sign in with a link sent by email. Nothing to remember.
export default async function Login({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string; next?: string; ref?: string; deleted?: string }> }) {
  if (!isHosted()) redirect("/");
  if (await sessionUserId()) redirect("/");
  const { sent, error, next, ref, deleted } = await searchParams;
  return (
    <Page title={sent ? "Check your email" : "Sign in"}>
      {sent ? (
        <p className="db-lead">We sent you a sign-in link. Open it in this browser to come straight back here.</p>
      ) : (
        <>
          <p className="db-lead">Your meetings, turned into your day. We&apos;ll email you a link to sign in.</p>
          {deleted ? <p className="db-note">Your account and everything in it are deleted.</p> : null}
          {error && ERRORS[error] ? <p className="db-note db-note--error" role="alert">{ERRORS[error]}</p> : null}
          <form action={sendSignInLink} className="db-stack">
            <Field id="email" name="email" type="email" label="Email" autoComplete="email" required autoFocus />
            <input type="hidden" name="next" value={next ?? "/"} />
            {ref ? <input type="hidden" name="ref" value={ref} /> : null}
            {ref ? <p className="db-h-muted">A friend&apos;s code <span className="db-mono">{ref.toUpperCase()}</span> gives you a free month.</p> : null}
            <div><Button type="submit">Email me a link</Button></div>
          </form>
        </>
      )}
    </Page>
  );
}
