import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { isHosted } from "@/server/mode";
import { sessionUserId, rootStore } from "@/server/hosted/app";
import { getEntitlement, referralCode } from "@/server/hosted/billing";
import { hostedConfig } from "@/server/hosted/config";
import { redeemCode, subscribe } from "../hosted-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Plan" };

const REDEEM: Record<string, string> = {
  ok: "Done: your free month has started.",
  unknown_code: "We don't know that code.",
  own_code: "That's your own code. Share it with a friend instead.",
  already_redeemed: "You've already used a friend's code.",
  already_paying: "You're already subscribed, so the code can't add anything.",
  disabled: "Billing is off.",
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

// Hosted mode: your plan, this month's meetings, subscribing (Razorpay test mode) and referrals.
export default async function Billing({ searchParams }: { searchParams: Promise<{ redeem?: string; error?: string }> }) {
  if (!isHosted()) notFound();
  const uid = await sessionUserId();
  if (!uid) redirect("/login");
  const cfg = hostedConfig();
  const b = cfg.billing;
  const db = rootStore().db;
  const ent = await getEntitlement(db, uid, b, new Date());
  const code = await referralCode(db, uid);
  const { redeem, error } = await searchParams;

  if (!b.enabled) {
    return (
      <Page title="Plan">
        <p className="db-lead">Billing is off on this server: you have everything, with no limits.</p>
        <p className="db-h-muted">{ent.usedThisMonth} meetings read this month.</p>
      </Page>
    );
  }

  return (
    <Page title="Plan">
      {redeem && REDEEM[redeem] ? <p className={`db-note${redeem === "ok" ? "" : " db-note--error"}`}>{REDEEM[redeem]}</p> : null}
      {error ? <p className="db-note db-note--error" role="alert">Couldn&apos;t start the subscription. Try again in a minute.</p> : null}
      <section className="db-h-card">
        <h2 className="db-h-card__title">{ent.plan === "paid" ? "Subscribed" : ent.plan === "comp" ? "Free month" : "Free plan"}</h2>
        {ent.plan === "free" ? (
          <>
            <p className="db-h-big">{ent.usedThisMonth} <span className="db-h-muted">of {ent.limit} meetings this month</span></p>
            <p className="db-h-muted">Meetings past the limit wait, unread, until the 1st or until you subscribe. Nothing is lost.</p>
          </>
        ) : (
          <p className="db-h-muted">
            Every meeting is read.{" "}
            {ent.plan === "comp" && ent.compUntil ? `Free until ${day(ent.compUntil)}.` : null}
            {ent.plan === "paid" && ent.subscription?.currentEnd ? `Renews ${day(ent.subscription.currentEnd)}.` : null}
          </p>
        )}
        {ent.plan !== "paid" ? (
          <form action={subscribe}>
            <Button type="submit" variant="highlight">Subscribe · ₹{b.priceInr}/month</Button>
            <p className="db-h-muted" style={{ marginTop: 8 }}>Razorpay test mode: use a test card, no money moves.</p>
          </form>
        ) : null}
      </section>

      <section className="db-h-card">
        <h2 className="db-h-card__title">Give a friend a free month</h2>
        {code ? (
          <>
            <p className="db-h-row"><span className="db-h-code">{code}</span></p>
            <p className="db-h-muted">Or send them {cfg.appUrl}/login?ref={code}. When they first pay, you get a free month too.</p>
          </>
        ) : null}
        <form action={redeemCode} className="db-stack">
          <Field id="code" name="code" label="Have a friend's code?" autoComplete="off" />
          <div><Button type="submit" variant="secondary">Use code</Button></div>
        </form>
      </section>
    </Page>
  );
}
