import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Stats } from "@/components/CloseWrap";
import { Mark } from "@/components/Mark";
import { Shell } from "@/components/Shell";
import { MissedRow } from "@/components/crosscheck/CrossCheck";
import { localDate } from "@/lib/brief/time";
import { openMissed, totals } from "@/lib/crosscheck/compare";
import { crossAllState } from "@/server/crosscheck/all";
import { crosscheckEnabled } from "@/server/crosscheck/core";
import { getFileStore, me } from "@/server/local/app";
import { isHosted } from "@/server/mode";
import { crossCheckAllAction } from "../crosscheck-actions";
import { openCountFor, pastDays } from "../_lib/days";
import { shortDate } from "../_lib/lines";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cross-check with Wispr Flow" };

const STATUS: Record<string, string> = {
  no_summary: "Wispr Flow has no summary for this meeting.",
  no_actions: "Wispr Flow's summary lists no next steps.",
};

export default async function CrossCheckPage() {
  if (isHosted()) notFound();
  const user = await me();
  if (!user) redirect("/setup");
  const store = getFileStore();
  const records = (await store.listCrossChecks(user.id)).filter((r) => store.meetings.has(r.meetingId));
  const meetings = new Map([...store.meetings.values()].map((m) => [m.id, m]));
  const items = new Map((await store.listItems(user.id)).map((i) => [i.id, i]));
  const byNewest = [...records].sort((a, b) => (meetings.get(b.meetingId)?.startedAt ?? "").localeCompare(meetings.get(a.meetingId)?.startedAt ?? ""));
  const t = totals(records);
  const run = crossAllState();
  const on = crosscheckEnabled();
  const withMissed = byNewest.filter((r) => openMissed(r).length);
  const only = byNewest.flatMap((r) => r.onlyInApp.map((id) => ({ r, item: items.get(id) }))).filter((x) => x.item && x.item.status !== "wrong");
  const errors = byNewest.filter((r) => r.status === "error");
  const quiet = byNewest.filter((r) => STATUS[r.status]);
  const title = (id: string) => meetings.get(id)?.title || "Meeting";
  const when = (id: string) => { const m = meetings.get(id); return m ? shortDate(m.startedAt, user.timeZone) : ""; };

  return (
    <Shell days={await pastDays(user.id, localDate(new Date(), user.timeZone))} current="review" openCount={await openCountFor(user.id)}>
      <p className="db-crumb"><Link className="db-link" href="/review">Review</Link></p>
      <h1 className="db-title">Cross-check with Wispr Flow</h1>
      <p className="db-subtitle">
        Wispr Flow&apos;s own action items next to what Daily brief found.{" "}
        {records.length ? `${t.meetings} meeting${t.meetings === 1 ? "" : "s"} compared.` : "Nothing compared yet."}
      </p>

      <div className="xc-bar">
        <form action={crossCheckAllAction}>
          <button className="db-act db-act--primary" disabled={run?.running}>{run?.running ? "Cross-checking…" : "Cross-check all meetings"}</button>
        </form>
        {run?.running ? (
          <span className="xc-progress" role="status">
            <span className="xc-progress__bar" aria-hidden="true"><i style={{ width: `${run.total ? Math.round((run.done / run.total) * 100) : 0}%` }} /></span>
            <span className="db-mono">{run.done} of {run.total}</span>
            <AutoRefresh seconds={3} />
          </span>
        ) : run?.error ? <span className="xc-progress xc-progress--error" role="alert">{run.error}</span>
          : run ? <span className="xc-progress db-mono" role="status">Done · {run.done} meeting{run.done === 1 ? "" : "s"}{run.failed ? ` · ${run.failed} couldn't be checked` : ""}</span> : null}
        <span className="xc-bar__gap" />
        <Link className="cw-pill" href="/setup#ai-crosscheck">{on ? "After each meeting: on" : "After each meeting: off"}</Link>
      </div>

      <Stats items={[
        { label: "Matched", value: t.matched },
        { label: "Missed by Daily brief", value: t.missed },
        { label: "Only in Daily brief", value: t.onlyInApp },
        { label: "Not yours", value: t.notYours },
      ]} />
      {t.markedWrong ? <p className="rv-more db-mono">{t.markedWrong} matched an item you marked Wrong</p> : null}

      <section className="db-section" aria-labelledby="xc-missed-h">
        <div className="db-section__head">
          <h2 className="db-section__title" id="xc-missed-h">Missed by Daily brief</h2>
          {t.missed ? <span className="db-section__count">{t.missed}</span> : null}
        </div>
        {withMissed.length ? withMissed.map((r) => (
          <div key={r.meetingId} className="xc-group">
            <h3 className="xc-group__title">
              <Link className="rv-plain" href={`/meeting/${encodeURIComponent(r.meetingId)}`}>{title(r.meetingId)}</Link>
              <span className="xc-group__when">{when(r.meetingId)}</span>
            </h3>
            <ul className="xc-list">
              {openMissed(r).map(({ e, i }) => <MissedRow key={i} meetingId={r.meetingId} index={i} e={e} />)}
            </ul>
          </div>
        )) : <p className="db-section__empty">{records.length ? "Nothing Wispr Flow listed for you is missing." : "Turn on the cross-check in Settings › AI, or cross-check all meetings above."}</p>}
      </section>

      <section className="db-section" aria-labelledby="xc-only-h">
        <div className="db-section__head">
          <h2 className="db-section__title" id="xc-only-h">Only in Daily brief</h2>
          {only.length ? <span className="db-section__count">{only.length}</span> : null}
        </div>
        {only.length ? (
          <ul className="xc-list">
            {only.map(({ r, item }) => (
              <li key={item!.id} className="xc-only">
                <span className="xc-only__mark"><Mark kind={item!.status === "done" ? "done" : item!.kind} /></span>
                <Link className="xc-only__text rv-plain" href={`/item/${encodeURIComponent(item!.id)}`}>{item!.text}</Link>
                <span className="xc-only__src">{item!.person ? `${item!.person} · ` : ""}{title(r.meetingId)}, {when(r.meetingId)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="db-section__empty">Every item Daily brief found is in Wispr Flow&apos;s list too.</p>}
      </section>

      {errors.length || quiet.length ? (
        <section className="db-section" aria-labelledby="xc-skip-h">
          <div className="db-section__head"><h2 className="db-section__title" id="xc-skip-h">Not compared</h2></div>
          <ul className="xc-list">
            {[...errors, ...quiet].map((r) => (
              <li key={r.meetingId} className="xc-skip">
                <Link className="rv-plain" href={`/meeting/${encodeURIComponent(r.meetingId)}`}>{title(r.meetingId)}</Link>
                <span className="xc-only__src">{r.status === "error" ? r.error : STATUS[r.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Shell>
  );
}
