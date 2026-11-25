import { AutoRefresh } from "@/components/AutoRefresh";
import { getStore, me } from "@/server/local/app";
import { pullState } from "@/server/local/scheduler";

/** One line at the top of every page while meetings are being read, with a bar and live count. */
export async function Progress() {
  const user = await me();
  if (!user) return null;
  const store = getStore();
  const unread = (await store.listUnprocessedMeetings(user.id)).length;
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

  const meetings = await store.listMeetingsBetween(user.id, "0000", "9999");
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
