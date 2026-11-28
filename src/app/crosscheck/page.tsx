import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Shell } from "@/components/Shell";
import { AddAllMissed } from "@/components/reading/AddAllMissed";
import { Chips, Detail, DetailBar, Head, Kv, LinkGroups, ListBar, MList, Sec, Stats, type LinkGroup } from "@/components/reading/Frame";
import { formatTime, localDate } from "@/lib/brief/time";
import { openMissed, totals, type CrossCheckRecord } from "@/lib/crosscheck/compare";
import { dayName, shortDay } from "@/lib/reading/model";
import { crossAllState } from "@/server/crosscheck/all";
import { crosscheckEnabled } from "@/server/crosscheck/core";
import { getFileStore, me } from "@/server/local/app";
import { isHosted } from "@/server/mode";
import { addFromCrossCheckAction, crossCheckAllAction, ignoreCrossCheckAction } from "../crosscheck-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cross-check with Wispr Flow" };

const STATUS: Record<string, string> = {
  no_summary: "Wispr Flow has no summary for this meeting.",
  no_actions: "Wispr Flow's summary lists no next steps.",
};

// Cross-check, side by side per meeting: the meetings where Wispr Flow noted something Daily brief
// doesn't have, newest first; the picked one as a table of Wispr Flow's line, Daily brief's item and
// a verdict, with Add on each missed line.
export default async function CrossCheckPage({ searchParams }: { searchParams: Promise<{ m?: string; show?: string }> }) {
  if (isHosted()) notFound();
  const user = await me();
  if (!user) redirect("/setup");
  const q = await searchParams;
  const tz = user.timeZone;
  const store = getFileStore();
  const records = (await store.listCrossChecks(user.id)).filter((r) => store.meetings.has(r.meetingId));
  const meetings = new Map([...store.meetings.values()].map((m) => [m.id, m]));
  const items = new Map((await store.listItems(user.id)).map((i) => [i.id, i]));
  const byNewest = [...records].sort((a, b) => (meetings.get(b.meetingId)?.startedAt ?? "").localeCompare(meetings.get(a.meetingId)?.startedAt ?? ""));
  const t = totals(records);
  const run = crossAllState();
  const on = crosscheckEnabled();
  const withGaps = byNewest.filter((r) => openMissed(r).length);
  const allMatch = byNewest.filter((r) => !openMissed(r).length && (r.status === "ok" || r.status === "no_actions"));
  const notCompared = byNewest.filter((r) => r.status === "error" || STATUS[r.status]);
  const show = q.show === "match" ? "match" : q.show === "skipped" ? "skipped" : "gaps";
  const shown = show === "match" ? allMatch : show === "skipped" ? notCompared : withGaps;
  const title = (id: string) => meetings.get(id)?.title || "Meeting";
  const when = (id: string) => { const m = meetings.get(id); return m ? shortDay(m.startedAt, tz) : ""; };
  const base = (m?: string) => `/crosscheck?${new URLSearchParams({ ...(show !== "gaps" ? { show } : {}), ...(m ? { m } : {}) })}`.replace(/\?$/, "");
  const sel = q.m && records.some((r) => r.meetingId === q.m) ? q.m : shown[0]?.meetingId ?? null;

  const matchedOf = (r: CrossCheckRecord) => r.entries.filter((e) => e.verdict === "matched" || e.verdict === "matched_wrong").length;
  const groups: LinkGroup[] = [{
    key: show, label: "Newest first",
    rows: shown.map((r) => {
      const missed = openMissed(r).length;
      const matched = matchedOf(r);
      return {
        key: r.meetingId, href: base(r.meetingId), title: title(r.meetingId), mark: missed ? "late" : r.status === "error" ? "dot" : "done",
        sub: `${when(r.meetingId)} · ${r.status === "error" ? r.error ?? "Couldn't be checked" : STATUS[r.status] ?? ([missed ? `${missed} missed` : "", matched ? `${matched} matched` : ""].filter(Boolean).join(", ") || "Nothing for you")}`,
        num: missed ? { n: missed } : undefined,
      };
    }),
    empty: show === "gaps" ? (records.length ? "Nothing Wispr Flow listed for you is missing." : "Nothing compared yet. Cross-check all meetings to start.") : "None.",
  }];
  const list = (
    <>
      <ListBar title="Cross-check" count={`${withGaps.length} meeting${withGaps.length === 1 ? "" : "s"}`} back={{ href: "/review", label: "Review" }} />
      <Chips chips={[
        { label: "With gaps", n: withGaps.length, href: "/crosscheck", on: show === "gaps" },
        { label: "All match", n: allMatch.length, href: "/crosscheck?show=match", on: show === "match" },
        ...(notCompared.length ? [{ label: "Not compared", n: notCompared.length, href: "/crosscheck?show=skipped", on: show === "skipped" }] : []),
      ]} />
      <LinkGroups groups={groups} sel={sel} limit={30} />
    </>
  );

  const rec = sel ? records.find((r) => r.meetingId === sel) ?? null : null;
  const runBar = (
    <div className="xc-bar">
      <form action={crossCheckAllAction}>
        <button className="rp-btn" disabled={run?.running}>{run?.running ? "Cross-checking…" : "Cross-check all meetings"}</button>
      </form>
      {run?.running ? (
        <span className="xc-progress" role="status">
          <span className="xc-progress__bar" aria-hidden="true"><i style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }} /></span>
          <span className="db-mono">{run.done} of {run.total}</span>
          <AutoRefresh seconds={3} />
        </span>
      ) : run?.error ? <span className="xc-progress xc-progress--error" role="alert">{run.error}</span> : null}
    </div>
  );
  const rail = (
    <>
      <Sec title="Last run">
        <Kv rows={[
          rec ? ["Checked", `${dayName(localDate(new Date(rec.checkedAt), tz))}, ${formatTime(rec.checkedAt, tz)}`] : null,
          ["Meetings", String(t.meetings)],
          rec?.model ? ["Model", rec.model] : null,
          ["After each", <Link key="s" href="/setup?section=ai#ai-crosscheck">{on ? "On" : "Off"}</Link>],
        ]} />
      </Sec>
      <Sec title="Wispr Flow vs Daily brief">
        <div className="rp-meter" aria-hidden="true">
          <span className="rp-meter__k" style={{ width: `${(t.matched / Math.max(1, t.matched + t.missed + t.onlyInApp)) * 100}%` }} />
          <span className="rp-meter__w" style={{ width: `${(t.missed / Math.max(1, t.matched + t.missed + t.onlyInApp)) * 100}%` }} />
          <span className="rp-meter__o" style={{ width: `${(t.onlyInApp / Math.max(1, t.matched + t.missed + t.onlyInApp)) * 100}%` }} />
        </div>
        <div style={{ marginTop: 8 }}>
          <MList rows={[{ key: "m", label: "Matched", right: t.matched }, { key: "x", label: "Missed by Daily brief", right: t.missed }, { key: "o", label: "Only in Daily brief", right: t.onlyInApp }, { key: "n", label: "Not yours", right: t.notYours }]} />
        </div>
      </Sec>
      <Sec title="Run it again">{runBar}</Sec>
    </>
  );

  let detail;
  if (!rec) {
    detail = (
      <Detail bar={<DetailBar crumb={[{ label: "Review", href: "/review" }, { label: "Cross-check" }]} listHref="/crosscheck" />} rail={rail}>
        <Head kind="Cross-check with Wispr Flow" title="Nothing to compare yet" lede="Wispr Flow's own action items next to what Daily brief found, one meeting at a time." />
        {runBar}
      </Detail>
    );
  } else {
    const m = meetings.get(rec.meetingId);
    const mine = rec.entries.map((e, i) => ({ e, i })).filter(({ e }) => e.verdict !== "not_user");
    const missed = openMissed(rec);
    const kept = mine.length - missed.length;
    const only = rec.onlyInApp.map((id) => items.get(id)).filter((i) => i && i.status !== "wrong");
    const pos = shown.findIndex((r) => r.meetingId === rec.meetingId) + 1;
    const people = [...new Set(mine.map(({ e }) => e.person).filter(Boolean))].slice(0, 3) as string[];
    detail = (
      <Detail full
        bar={<DetailBar crumb={[{ label: "Review", href: "/review" }, { label: "Cross-check", href: "/crosscheck" }, { label: title(rec.meetingId) }]} listHref={base()}
          acts={<>{pos ? <span className="rp-pos">{pos} of {shown.length}</span> : null}<AddAllMissed meetingId={rec.meetingId} rows={missed.map(({ e, i }) => ({ index: i, kind: e.kind ?? "owe" }))} /></>} />}
      >
        <Head kind={`Meeting · ${m ? `${dayName(localDate(new Date(m.startedAt), tz))}, ${formatTime(m.startedAt, tz)}` : ""}${people.length ? ` · with ${people.join(", ")}` : ""}`}
          title={<Link href={`/meeting/${encodeURIComponent(rec.meetingId)}`} className="rp-plain">{title(rec.meetingId)}</Link>}
          lede={rec.status === "error" ? rec.error ?? "This meeting couldn't be checked." : STATUS[rec.status] ?? `Wispr Flow noted ${mine.length} thing${mine.length === 1 ? "" : "s"} for you. Daily brief has ${kept} of them.${missed.length ? ` The other ${missed.length} ${missed.length === 1 ? "is" : "are"} below in red.` : ""}`} />
        {mine.length ? (
          <table className="rp-xt">
            <colgroup><col style={{ width: "44%" }} /><col style={{ width: "38%" }} /><col style={{ width: "18%" }} /></colgroup>
            <thead><tr><th>Wispr Flow&apos;s notes</th><th>Daily brief</th><th /></tr></thead>
            <tbody>
              {mine.map(({ e, i }) => {
                const it = e.itemId ? items.get(e.itemId) : e.addedItemId ? items.get(e.addedItemId) : undefined;
                const isMissed = e.verdict === "missed" && !e.ignored && !e.addedItemId;
                return (
                  <tr key={i} className={isMissed ? "rp-xt--miss" : undefined}>
                    <td>{e.wispr.owner ? `(${e.wispr.owner}) ` : ""}{e.wispr.text}{e.droppedReason ? <small>Daily brief left it out: {e.droppedReason}</small> : null}</td>
                    {isMissed ? <td className="rp-xt__no">Not in Daily brief</td>
                      : <td>{it ? <Link className="rp-plain" href={`/item/${encodeURIComponent(it.id)}`}>{it.text}</Link> : e.ignored ? <span className="rp-quiet">Ignored</span> : "—"}</td>}
                    <td>
                      {isMissed ? (
                        <>
                          <form action={addFromCrossCheckAction}>
                            <input type="hidden" name="meetingId" value={rec.meetingId} /><input type="hidden" name="index" value={i} /><input type="hidden" name="kind" value={e.kind ?? "owe"} />
                            <button className="rp-addb" title={e.kind === "waiting" ? "Add as Waiting on" : "Add as You owe"}>Add</button>
                          </form>
                          <form action={ignoreCrossCheckAction}>
                            <input type="hidden" name="meetingId" value={rec.meetingId} /><input type="hidden" name="index" value={i} />
                            <button className="rp-addb rp-addb--q">Ignore</button>
                          </form>
                        </>
                      ) : e.addedItemId ? <span className="rp-vd rp-vd--ok">Added</span>
                        : e.verdict === "matched_wrong" ? <span className="rp-vd">Marked wrong</span>
                          : e.ignored ? <span className="rp-vd">Ignored</span>
                            : <span className="rp-vd rp-vd--ok">{it?.status === "done" ? "Kept" : "Matched"}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {only.length ? (
          <p className="rp-note">Daily brief also heard {only.length === 1 ? "1 thing" : `${only.length} things`} here that Wispr Flow didn&apos;t note: {only.map((i, k) => <span key={i!.id}>{k ? "; " : ""}<Link className="rp-plain" href={`/item/${encodeURIComponent(i!.id)}`}>{i!.text}</Link></span>)}.</p>
        ) : null}
        <Sec title={`Across all ${t.meetings} meetings`}>
          <Stats items={[{ n: t.matched, label: "Matched" }, { n: t.missed, label: "Missed by Daily brief", late: !!t.missed }, { n: t.onlyInApp, label: "Only in Daily brief" }, { n: t.notYours, label: "Not yours" }]} />
          <div style={{ marginTop: 12 }}>{runBar}</div>
          <p className="rp-note" style={{ marginTop: 8 }}>{rec.model ? `Checked with ${rec.model}. ` : ""}After each meeting: <Link href="/setup?section=ai#ai-crosscheck">{on ? "on" : "off"}</Link>.</p>
        </Sec>
      </Detail>
    );
  }
  return <Shell current="crosscheck" list={list} detail={detail} show={q.m ? "detail" : "list"} />;
}
