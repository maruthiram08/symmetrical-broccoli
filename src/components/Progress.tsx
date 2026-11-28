import { AutoRefresh } from "@/components/AutoRefresh";
import { Alerts, loadAlerts } from "@/components/Alerts";
import { getStore, me } from "@/server/local/app";
import { readingBlocked } from "@/server/local/health";
import { pullState } from "@/server/local/scheduler";

/**
 * The top of every page: banners for problems the user must fix (Alerts), then one line while
 * meetings are being read, with a bar and live count.
 */
export async function Progress() {
  const user = await me();
  if (!user) return null;
  const alerts = await loadAlerts(user);
  return (
    <>
      <Alerts alerts={alerts} user={user} />
      {readingBlocked(alerts) ? null : <ReadingProgress userId={user.id} />}
    </>
  );
}

async function ReadingProgress({ userId }: { userId: string }) {
  const store = getStore();
  // Meetings that failed wait for a retry (or are set aside): they aren't "being read" right now,
  // and counting them would keep this bar, and the page refresh, going forever.
  const unread = (await store.listUnprocessedMeetings(userId)).filter((m) => !m.failedAttempts).length;
  const pull = pullState();
  const recent = pull && !pull.running && Date.now() - Date.parse(pull.startedAt) < 60 * 60_000;

  if (unread === 0 && !pull?.running) {
    if (!recent) return null;
    return (
      <p className="db-banner" role="status">
        {pull.error ?? `Done. All your meetings are read${pull.mode === "rebuild" ? " in order" : ""}.`}
      </p>
    );
  }

  const meetings = (await store.listMeetingsBetween(userId, "0000", "9999")).filter((m) => m.processedAt || !m.failedAttempts);
  const total = meetings.length;
  const done = total - unread;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const what = pull?.running && pull.mode === "rebuild" ? "Re-reading your meetings, oldest first" : "Reading your meetings";
  return (
    <div className="db-progress" role="status" aria-live="polite">
      <div className="db-progress__text">
        <span>{unread || !pull?.running ? `${what}: ` : "Finding your meetings…"}</span>
        {unread || !pull?.running ? <span className="db-mono">{done} of {total} done</span> : null}
        <span className="db-progress__hint">Still working. This page updates by itself.</span>
      </div>
      <div className="db-progress__bar"><i style={{ width: `${pct}%` }} /></div>
      <AutoRefresh seconds={6} />
    </div>
  );
}
