import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Button, ButtonLink } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { isHosted } from "@/server/mode";
import { userStore } from "@/server/hosted/app";
import { hostedConfig } from "@/server/hosted/config";
import { deleteAccount, saveDelivery, signOut } from "../hosted-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Account" };

const ERRORS: Record<string, string> = {
  slack: "That isn't a Slack incoming-webhook address (https://hooks.slack.com/services/…).",
  none: "Keep at least one way to get your brief: email or Slack.",
  confirm: "Type DELETE to confirm.",
};

// Hosted mode: how the brief reaches you, your data, signing out.
export default async function Account({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  if (!isHosted()) notFound();
  const store = await userStore().catch(() => null);
  if (!store) redirect("/login");
  const user = await store.getUser(store.scope!);
  if (!user) redirect("/login");
  const delivery = await store.getDelivery(user.id);
  const { saved, error } = await searchParams;
  const cfg = hostedConfig();
  return (
    <Page title="Account">
      <p className="db-lead">Signed in as {user.email}.</p>
      {saved ? <p className="db-note">Saved.</p> : null}
      {error && ERRORS[error] ? <p className="db-note db-note--error" role="alert">{ERRORS[error]}</p> : null}

      <section className="db-h-card">
        <h2 className="db-h-card__title">Your daily brief</h2>
        <form action={saveDelivery} className="db-stack">
          <label className="db-check"><input type="checkbox" name="email" defaultChecked={delivery.email} /> <span className="db-check__label">Email it to {user.email}</span></label>
          <Field id="slack" name="slack" type="url" label="Slack (optional)" hint="An incoming-webhook URL from your Slack workspace. The brief is posted there too." defaultValue={delivery.slackWebhook ?? ""} placeholder="https://hooks.slack.com/services/…" />
          <div><Button type="submit" variant="secondary">Save</Button></div>
        </form>
      </section>

      <section className="db-h-card">
        <h2 className="db-h-card__title">Your data</h2>
        <div className="db-h-row">
          <ButtonLink href="/api/account/export" variant="secondary">Download my data</ButtonLink>
          {cfg.billing.enabled ? <ButtonLink href="/billing" variant="ghost">Plan and billing</ButtonLink> : null}
          {cfg.teamsEnabled ? <ButtonLink href="/team" variant="ghost">Teams</ButtonLink> : null}
        </div>
        <form action={deleteAccount} className="db-stack">
          <Field id="confirm" name="confirm" label="Delete my account" hint="Deletes your meetings, items, briefs and Wispr Flow connection. Type DELETE." autoComplete="off" />
          <div><Button type="submit" variant="ghost">Delete everything</Button></div>
        </form>
      </section>

      <form action={signOut} style={{ marginTop: 24 }}><Button type="submit" variant="ghost">Sign out</Button></form>
    </Page>
  );
}
