import type { Metadata } from "next";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { TimeZoneSelect } from "@/components/TimeZoneSelect";
import { getStore, me } from "@/server/local/app";
import { redirect } from "next/navigation";
import { SubmitOnChange } from "@/components/SubmitOnChange";
import { pullMeetingsSince, rereadAllMeetings, saveIncludeShared, saveSetup } from "../actions";
import { pullState, schedulerStatus } from "@/server/local/scheduler";
import { formatBytes, summarizeHealth } from "@/server/local/health";
import { formatTime, localDate } from "@/lib/brief/time";
import { ChannelHealthRows, ChannelSettings } from "@/components/channels/ChannelSettings";
import { BRIEF_TIMES, formatBriefTime, timeZones, todayIn } from "../_lib/time";
import { IntegrationsSettings } from "@/components/integrations/IntegrationsSettings";
import { SourcesSection } from "@/components/SourcesSection";
import { sourceStatuses } from "@/server/recorders/status";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Setup" };

export default async function Setup({ searchParams }: { searchParams: Promise<{ error?: string; pull?: string; shared?: string; upload?: string; source?: string; which?: string; integ?: string; ch?: string; saved?: string; test?: string; err?: string; removed?: string }> }) {
  const user = await me();
  const conn = user ? await getStore().getConnection(user.id) : null;
  // First run happens on /welcome; Settings is for changing things afterwards.
  if (!user || !conn) redirect("/welcome");
  const connected = conn?.status === "active";
  const { error, pull, shared, upload, source, which, integ, ...flash } = await searchParams;
  const pulling = pullState()?.running ?? false;
  const tz = user?.timeZone ?? "Asia/Kolkata";
  const today = todayIn(tz);
  const monthAgo = todayIn(tz, new Date(Date.now() - 30 * 24 * 60 * 60_000));
  // "Also pull shared meetings since": as far back as your own meetings go.
  const oldest = (await getStore().listMeetingsBetween(user.id, "0000", "9999")).reduce<string | null>((a, m) => (!a || m.startedAt < a ? m.startedAt : a), null);
  const sharedSince = oldest ? todayIn(tz, new Date(oldest)) : todayIn(tz, new Date(Date.now() - 7 * 24 * 60 * 60_000));
  // Guess from the browser only until the user has saved a name (i.e. first visit).
  const firstVisit = !user?.name;
  const store = getStore();
  const health = user ? summarizeHealth({ health: await store.getHealth(), events: await store.listEvents(), statePath: store.path, now: new Date() }) : null;
  const jobs = schedulerStatus();
  const at = (iso: string | null) => {
    if (!iso) return "Not yet";
    const d = localDate(new Date(iso), tz);
    return `${d === today ? "Today" : d}, ${formatTime(iso, tz)}`;
  };
  return (
    <Page title="Set up your brief">
      <p className="db-lead">{connected ? "Change your details. Your meetings stay connected." : "A few things, then connect your meetings. Everything stays on this Mac."}</p>
      <form action={saveSetup} className="db-stack">
        <Field id="name" name="name" label="Your name" hint="So we know which promises are yours." defaultValue={user?.name ?? ""} autoComplete="name" required />
        <Field id="aliases" name="aliases" label="Other names people call you" hint="Comma separated, like Maru, MR. Optional." defaultValue={user?.aliases.join(", ") ?? ""} />
        <Field id="timeZone" label="Time zone">
          <TimeZoneSelect id="timeZone" name="timeZone" zones={timeZones()} value={user?.timeZone ?? "Asia/Kolkata"} guess={firstVisit} />
        </Field>
        <Field id="briefTime" label="Brief me at">
          <select className="db-input" id="briefTime" name="briefTime" defaultValue={user?.briefTime ?? "18:00"}>
            {BRIEF_TIMES.map((t) => (
              <option key={t} value={t}>
                {formatBriefTime(t)}
              </option>
            ))}
          </select>
        </Field>
        <div className="db-row">
          {connected ? (
            <>
              <Button type="submit">Save</Button>
              <Button type="submit" variant="ghost" name="reconnect" value="1">
                Reconnect Wispr Flow
              </Button>
            </>
          ) : (
            <Button type="submit" variant="highlight">
              Connect Wispr Flow
            </Button>
          )}
        </div>
        {error ? (
          <p className="db-note db-note--error" role="alert">
            {error === "wispr"
              ? "Couldn't connect Wispr Flow. Try again."
              : "Something in the form didn't look right. Check it and try again."}
          </p>
        ) : null}
      </form>
      {connected ? (
        <form action={pullMeetingsSince} className="db-stack db-subsection">
          <h2 className="db-section__title">Pull in older meetings</h2>
          <Field
            id="since"
            name="since"
            type="date"
            label="All meetings since"
            hint="Reads every Wispr Flow meeting from this date on. Meetings already here are skipped. Each new meeting is one AI read, so a long range takes a few minutes."
            max={today}
            defaultValue={monthAgo}
            required
          />
          <div className="db-row">
            <Button type="submit" disabled={pulling}>
              {pulling ? "Pulling meetings…" : "Pull meetings"}
            </Button>
          </div>
          {pull === "bad" ? (
            <p className="db-note db-note--error" role="alert">
              Pick a date that isn&apos;t in the future.
            </p>
          ) : null}
        </form>
      ) : null}
      {connected ? (
        <section id="shared" className="db-stack db-subsection">
          <h2 className="db-section__title">Shared meetings</h2>
          <form action={saveIncludeShared} className="db-stack">
            <label className="db-check">
              <SubmitOnChange name="includeShared" defaultChecked={user.includeShared === true} />
              <span>
                <span className="db-check__label">Include meetings others shared with me</span>
                <span className="db-field__hint">
                  Meetings a colleague recorded and shared with you. Something counts as yours only when you speak in it; otherwise
                  you see what others promised you and decisions that name you. Marked <span className="db-item__shared">shared</span>.
                </span>
              </span>
            </label>
            <noscript>
              <Button type="submit" variant="secondary">Save</Button>
            </noscript>
          </form>
          {shared === "on" && user.includeShared ? (
            <form action={pullMeetingsSince} className="db-offer">
              <p>New shared meetings come in from now on. Read the ones you already have too?</p>
              <div className="db-row">
                <label className="db-offer__date">
                  <span>Also pull shared meetings since</span>
                  <input className="db-input db-mono" type="date" name="since" max={today} defaultValue={sharedSince} required aria-label="Since" />
                </label>
                <Button type="submit" disabled={pulling}>{pulling ? "Pulling meetings…" : "Pull shared meetings"}</Button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}
      <SourcesSection statuses={sourceStatuses(user, [...getStore().meetings.values()].filter((m) => m.userId === user.id), new Date())} flash={{ upload, source, which }} />
      {connected ? (
        <form action={rereadAllMeetings} className="db-stack db-subsection">
          <h2 className="db-section__title">Re-read all meetings in order</h2>
          <p className="db-note" style={{ marginTop: 0 }}>
            Reads every meeting again, oldest first, so later meetings can close earlier promises. Use it after pulling in older
            meetings or when reading improves. Items you marked Done or Wrong stay marked. About ₹3.50 per meeting.
          </p>
          <div className="db-row">
            <Button type="submit" variant="secondary" disabled={pulling}>
              {pulling ? "Working…" : "Re-read all meetings"}
            </Button>
          </div>
        </form>
      ) : null}
      <ChannelSettings flash={flash} timeZone={tz} />
      <IntegrationsSettings flash={integ} timeZone={tz} />
      {health ? (
        <section className="db-stack db-subsection" aria-labelledby="health">
          <h2 className="db-section__title" id="health">Health</h2>
          <dl className="db-health">
            <dt>Last check of Wispr Flow</dt><dd>{at(health.lastPollOkAt)}</dd>
            <dt>Last meeting read</dt><dd>{at(health.lastExtractOkAt)}</dd>
            <dt>Last brief</dt><dd>{at(health.lastBriefAt)}</dd>
            <dt>Errors, last 24 hours</dt>
            <dd>
              {health.errors24h
                ? `${health.errors24h} (${health.errorsByJob.map(([j, n]) => `${j} ${n}`).join(" · ")}), last at ${at(health.lastErrorAt)}`
                : "None"}
            </dd>
            <ChannelHealthRows timeZone={tz} />
            <dt>Data file</dt><dd className="db-mono">{health.dataBytes === null ? "Not written yet" : formatBytes(health.dataBytes)}</dd>
            <dt>Background jobs</dt>
            <dd>{!jobs.running ? "Not started" : jobs.owner ? "Running here" : `Run by another Daily brief (pid ${jobs.holderPid ?? "?"})`}</dd>
            <dt>Version</dt><dd className="db-mono">{health.version}</dd>
          </dl>
        </section>
      ) : null}
    </Page>
  );
}
