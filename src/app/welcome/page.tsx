import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Button, ButtonLink } from "@/components/Button";
import { Field } from "@/components/Field";
import { FirstReadFields } from "@/components/FirstReadFields";
import { Page } from "@/components/Page";
import { TimeZoneSelect } from "@/components/TimeZoneSelect";
import { COST_PER_MEETING_INR } from "@/lib/extract/cost";
import { getStore, me } from "@/server/local/app";
import { onboardingStep } from "@/server/local/onboarding";
import { pullState } from "@/server/local/scheduler";
import { BRIEF_TIMES, formatBriefTime, nextBriefDay, startOfDayIso, timeZones, todayIn } from "../_lib/time";
import { connectWisprFlow, saveSetup, startFirstRead } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Welcome" };

const DAY_MS = 24 * 60 * 60_000;

type State = "done" | "current" | "todo";

function Step({ n, title, state, summary, children }: { n: number; title: string; state: State; summary?: ReactNode; children?: ReactNode }) {
  return (
    <li className={`db-step db-step--${state}`} aria-current={state === "current" ? "step" : undefined}>
      <div className="db-step__head">
        <span className="db-step__n db-mono" aria-hidden="true">{state === "done" ? "✓" : n}</span>
        <h2 className="db-step__title">{title}</h2>
        {summary ? <span className="db-step__summary">{summary}</span> : null}
      </div>
      {children ? <div className="db-step__body">{children}</div> : null}
    </li>
  );
}

/** First run: three steps on one page. / sends you here until the first read has started. */
export default async function Welcome({ searchParams }: { searchParams: Promise<{ edit?: string; error?: string; pull?: string }> }) {
  const { edit, error, pull: pullError } = await searchParams;
  const user = await me();
  const store = getStore();
  const conn = user ? await store.getConnection(user.id) : null;
  const pull = pullState();
  const reading = pull?.running ?? false;
  const step = onboardingStep(user, conn, reading);
  // Past onboarding and no first read in this run of the app to report on: nothing to show here.
  if (step === "done" && pull?.mode !== "pull") redirect("/");

  const tz = user?.timeZone ?? "Asia/Kolkata";
  const today = todayIn(tz);
  const weekAgo = todayIn(tz, new Date(Date.now() - 7 * DAY_MS));
  const editing = edit === "1" && step !== "done";
  const aboutState: State = step === "about" || editing ? "current" : "done";
  const connectState: State = editing ? (step === "about" || step === "connect" ? "todo" : "done") : step === "about" ? "todo" : step === "connect" ? "current" : "done";
  const readState: State = editing || step === "about" || step === "connect" ? "todo" : step === "read" ? "current" : reading ? "current" : "done";

  return (
    <Page title="Set up your brief">
      <p className="db-lead">Three short steps, then your meetings turn into your day. Everything stays in one folder on this Mac.</p>
      <ol className="db-steps">
        <Step
          n={1}
          title="About you"
          state={aboutState}
          summary={aboutState === "done" && user ? (
            <>
              {user.name} · {tz.replace(/_/g, " ")} · {formatBriefTime(user.briefTime)}
              {step !== "done" ? <> · <a className="db-link" href="/welcome?edit=1">Edit</a></> : null}
            </>
          ) : undefined}
        >
          {aboutState === "current" ? (
            <form action={saveSetup} className="db-stack">
              <input type="hidden" name="next" value="welcome" />
              <Field id="name" name="name" label="Your name" hint="So we know which promises are yours." defaultValue={user?.name ?? ""} autoComplete="name" required autoFocus />
              <Field id="aliases" name="aliases" label="Other names people call you" hint="Comma separated, like Maru, MR. Optional." defaultValue={user?.aliases.join(", ") ?? ""} />
              <div className="db-step__pair">
                <Field id="timeZone" label="Time zone">
                  <TimeZoneSelect id="timeZone" name="timeZone" zones={timeZones()} value={tz} guess={!user?.name} />
                </Field>
                <Field id="briefTime" label="Brief me at">
                  <select className="db-input" id="briefTime" name="briefTime" defaultValue={user?.briefTime ?? "18:00"}>
                    {BRIEF_TIMES.map((t) => <option key={t} value={t}>{formatBriefTime(t)}</option>)}
                  </select>
                </Field>
              </div>
              <div className="db-row">
                <Button type="submit">{editing ? "Save" : "Continue"}</Button>
                {editing ? <a className="db-link" href="/welcome">Cancel</a> : null}
              </div>
              {error === "1" ? <p className="db-note db-note--error" role="alert">Something in the form didn&apos;t look right. Check it and try again.</p> : null}
            </form>
          ) : null}
        </Step>

        <Step
          n={2}
          title="Connect Wispr Flow"
          state={connectState}
          summary={connectState === "done" ? (conn?.status === "needs_reconnect" ? "Signed out" : "Connected") : undefined}
        >
          {connectState === "current" ? (
            <form action={connectWisprFlow} className="db-stack">
              <p className="db-step__text">Your meetings come from Wispr Flow. You sign in on their site and come straight back here.</p>
              <div className="db-row">
                <Button type="submit" variant="highlight">Connect Wispr Flow</Button>
              </div>
              {error === "wispr" ? <p className="db-note db-note--error" role="alert">Couldn&apos;t connect Wispr Flow. Try again.</p> : null}
            </form>
          ) : connectState === "todo" ? (
            <p className="db-step__text">Sign in so the app can read your meeting transcripts.</p>
          ) : null}
        </Step>

        <Step n={3} title="Read your meetings" state={readState}>
          {readState === "todo" ? (
            <p className="db-step__text">Pick how far back to read. You see the count and cost before anything is read.</p>
          ) : step === "read" ? (
            <form action={startFirstRead} className="db-stack">
              <FirstReadFields defaultDate={weekAgo} max={today} />
              <div className="db-row">
                <Button type="submit" variant="highlight">Start reading</Button>
              </div>
              {pullError === "bad" ? <p className="db-note db-note--error" role="alert">Pick a date that isn&apos;t in the future.</p> : null}
            </form>
          ) : user && pull ? (
            <ReadProgress userId={user.id} date={pull.date} timeZone={tz} briefTime={user.briefTime} />
          ) : null}
        </Step>
      </ol>
    </Page>
  );
}

/** Live progress of the first read, then what it found. */
async function ReadProgress({ userId, date, timeZone, briefTime }: { userId: string; date: string; timeZone: string; briefTime: string }) {
  const store = getStore();
  const pull = pullState();
  const since = startOfDayIso(date, timeZone) ?? "0000";
  const meetings = await store.listMeetingsBetween(userId, since, "9999");
  const read = meetings.filter((m) => m.processedAt).length;
  const total = meetings.length;
  const label = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${date}T00:00:00Z`));

  if (pull?.running) {
    const finding = pull.found === null;
    const pct = total ? Math.round((read / total) * 100) : 0;
    return (
      <div className="db-stack">
        <div className="db-progress db-progress--flat" role="status" aria-live="polite">
          <div className="db-progress__text">
            {finding ? (
              <span>Finding your meetings since {label}…</span>
            ) : (
              <>
                <span>Reading</span>
                <span className="db-mono">{read} of {total}</span>
                <span>meetings</span>
                <span className="db-progress__hint">· about ₹{Math.round(read * COST_PER_MEETING_INR)} of ₹{Math.round(total * COST_PER_MEETING_INR)}</span>
              </>
            )}
          </div>
          <div className="db-progress__bar"><i style={{ width: `${finding ? 4 : Math.max(4, pct)}%` }} /></div>
          <AutoRefresh seconds={3} />
        </div>
        <p className="db-step__text">You can leave this page; reading carries on while the app runs. Your day fills in as it goes.</p>
        <div className="db-row">
          <ButtonLink href="/" variant="secondary">See your day</ButtonLink>
        </div>
      </div>
    );
  }

  const ids = new Set(meetings.map((m) => m.id));
  const owed = (await store.listItems(userId)).filter((i) => i.kind === "owe" && ids.has(i.meetingId));
  const open = owed.filter((i) => i.status === "open").length;
  return (
    <div className="db-stack">
      {pull?.error ? <p className="db-note db-note--error" role="alert" style={{ marginTop: 0 }}>{pull.error}</p> : null}
      <p className="db-done">
        Read <span className="db-mono">{read}</span> {read === 1 ? "meeting" : "meetings"} since {label}: <span className="db-mono">{owed.length}</span>{" "}
        {owed.length === 1 ? "promise" : "promises"}, <span className="db-mono">{open}</span> still open.
      </p>
      <p className="db-step__text">
        Your first brief arrives {nextBriefDay(briefTime, timeZone)} at <span className="db-mono">{formatBriefTime(briefTime)}</span>.
      </p>
      <div className="db-row">
        <ButtonLink href="/">See your day</ButtonLink>
      </div>
    </div>
  );
}
