import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { requestLink } from "./actions";

const ERRORS: Record<string, string> = {
  invalid_email: "That address doesn't look right. Check it and try again.",
  send_failed: "We couldn't send the link. Try again in a minute.",
  link: "That sign-in link has expired or was opened in another browser. Ask for a new one.",
};

export default async function Home({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const { sent, error } = await searchParams;
  return (
    <Page title="Your meetings, turned into your day">
      <p className="db-lead">
        One email each evening: what you owe, what you&apos;re waiting on, and what was decided. Items close themselves when a later meeting shows they&apos;re done.
      </p>
      {sent ? (
        <p className="db-note" role="status">
          Check your inbox. The link works for an hour, in this browser.
        </p>
      ) : (
        <form action={requestLink} className="db-stack">
          <Field id="email" name="email" type="email" label="Work email" placeholder="you@company.com" autoComplete="email" required />
          <div>
            <Button type="submit">Email me a link</Button>
          </div>
          {error && ERRORS[error] ? (
            <p className="db-note db-note--error" role="alert">
              {ERRORS[error]}
            </p>
          ) : null}
        </form>
      )}
    </Page>
  );
}
