import { dismissRecoveryNotice, retryFailedMeetings } from "@/app/actions";
import { formatTime, localDate } from "@/lib/brief/time";
import type { User } from "@/lib/types";
import { getStore } from "@/server/local/app";
import { RECOVERED_FROM_MEMORY } from "@/server/local/file-store";
import { alertsFor, type Alert } from "@/server/local/health";

/** The problems only the user can fix, on every page, each with what to do and a button. */
export async function loadAlerts(user: User): Promise<Alert[]> {
  const store = getStore();
  return alertsFor({
    conn: await store.getConnection(user.id),
    health: await store.getHealth(),
    recovery: await store.getRecovery(),
    meetings: await store.listUnprocessedMeetings(user.id),
    now: new Date(),
  });
}

function when(iso: string, tz: string): string {
  const today = localDate(new Date(), tz) === localDate(new Date(iso), tz);
  return `${today ? "" : `${localDate(new Date(iso), tz)} `}${formatTime(iso, tz)}`;
}

export function Alerts({ alerts, user }: { alerts: Alert[]; user: User }) {
  if (!alerts.length) return null;
  const retry = (
    <form action={retryFailedMeetings}>
      <button className="db-act" type="submit">Retry</button>
    </form>
  );
  return (
    <>
      {alerts.map((a) => {
        switch (a.kind) {
          case "recovered":
            return (
              <form key={a.kind} action={dismissRecoveryNotice} className="db-banner" role="alert">
                <span>
                  {a.from === RECOVERED_FROM_MEMORY
                    ? "Your data file was damaged, so Daily brief wrote it again from the copy it had open. Nothing should be missing."
                    : a.from
                    ? `Your data file was damaged, so Daily brief restored the last backup (${a.from}). Changes from just before that may be missing; recent meetings are read again.`
                    : "Your data file couldn't be read and there was no backup, so Daily brief started fresh."}
                  {a.corruptFile ? ` The damaged file is kept in ~/Daily Brief/.daily-brief/${a.corruptFile}.` : null}
                </span>
                <button className="db-act" type="submit">Dismiss</button>
              </form>
            );
          case "wispr_reconnect":
            return (
              <p key={a.kind} className="db-banner" role="alert">
                <span>Wispr Flow signed you out, so new meetings aren&apos;t coming in.</span>
                <a className="db-act" href="/api/wispr/connect">Reconnect Wispr Flow</a>
              </p>
            );
          case "wispr_unreachable":
            return (
              <p key={a.kind} className="db-banner" role="status">
                Couldn&apos;t reach Wispr Flow since {when(a.since, user.timeZone)}. Daily brief keeps trying; check your internet connection.
              </p>
            );
          case "anthropic_auth":
            return (
              <div key={a.kind} className="db-banner" role="alert">
                <span>
                  Anthropic didn&apos;t accept your API key, so meetings aren&apos;t being read. Put a working key in ANTHROPIC_API_KEY (.env.local, or the
                  Keychain for the Mac app with npm run keychain:import), restart Daily brief, then press Retry.
                </span>
                {retry}
              </div>
            );
          case "anthropic_credit":
            return (
              <div key={a.kind} className="db-banner" role="alert">
                <span>
                  Your Anthropic account is out of credit, so meetings aren&apos;t being read. Add credit at{" "}
                  <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noreferrer">console.anthropic.com</a>, then press Retry.
                </span>
                {retry}
              </div>
            );
          case "meetings_failed":
            return (
              <div key={a.kind} className="db-banner" role="alert">
                <span>{a.count} meeting{a.count === 1 ? "" : "s"} couldn&apos;t be read.</span>
                {retry}
              </div>
            );
        }
      })}
    </>
  );
}
