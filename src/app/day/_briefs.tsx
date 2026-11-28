// Daily briefs in the reading pane: past days in the list (This week / Last week / Earlier), and
// the picked day's brief beside your note for it, or either one alone.
import { redirect } from "next/navigation";
import { Backlinks } from "@/components/Backlinks";
import { DayNotes } from "@/components/DayNotes";
import { ExportMenu } from "@/components/ExportMenu";
import { Shell } from "@/components/Shell";
import { Chips, DetailBar, IRows, LinkGroups, ListBar, NoneDetail, Sec, Seg, type LinkGroup } from "@/components/reading/Frame";
import { localDate } from "@/lib/brief/time";
import { dayBadge, dayLede, dayLine, dayParts, itemLine, weekGroups } from "@/lib/reading/library";
import { longDay } from "@/lib/reading/model";
import { getStore, me } from "@/server/local/app";
import { readDayNote } from "@/server/local/notes";
import { editorContext } from "../_lib/editor";
import { loadAll } from "../_lib/lines";
import { readingCtx } from "../_lib/reading";

export type BriefView = "both" | "brief" | "note";

export async function DailyBriefs({ date, view, picked }: { date: string | null; view: BriefView; picked: boolean }) {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const today = localDate(now, user.timeZone);
  const { items, meetings } = await loadAll(user);
  const ctx = readingCtx(user, meetings, now);
  const dates = (await getStore().listBriefs(user.id)).map((b) => b.date).filter((d) => d <= today);
  const groups = weekGroups(dates, today);
  const sel = date ?? groups[0]?.dates[0] ?? null;
  const href = (d: string, v: BriefView = "both") => `/day/${d}${v === "both" ? "" : `?view=${v}`}`;

  const lists: LinkGroup[] = groups.map((g) => ({
    key: g.key, label: g.label,
    rows: g.dates.map((d) => {
      const p = dayParts(d, items, meetings, ctx);
      return { key: d, href: href(d, view), title: longDay(d), sub: dayLine(p, d === today), badge: dayBadge(d, today), mark: d === today ? "owe" : "dot", bold: d === today };
    }),
  }));
  const list = (
    <>
      <ListBar title="Daily briefs" count="Every evening" />
      {groups.length ? <Chips chips={groups.map((g) => ({ label: g.label, n: g.dates.length, href: `#rp-g-${g.key}` }))} /> : null}
      <LinkGroups groups={lists} sel={sel} foot={groups.length ? null : "No briefs yet. The first one arrives this evening."} />
    </>
  );

  let detail;
  const note = sel ? await readDayNote(user.id, sel) : null;
  if (!sel || !note) {
    detail = <NoneDetail crumb={[{ label: "Daily briefs" }]} listHref="/day" text={sel ? "No brief for that day." : "No briefs yet."} />;
  } else {
    const p = dayParts(sel, items, meetings, ctx);
    const owe = [...p.late, ...p.owe];
    const ihref = (id: string) => `/item/${encodeURIComponent(id)}`;
    const raw = note.brief.replace(/^---[\s\S]*?---\n+/, "").replace(/^# .*\n+/, "").trim();
    const brief = (
      <div className="rp-bcol">
        <div>
          <div className="rp-kind">Evening brief{sel === today ? " · today" : ""}</div>
          <h2 className="rp-dayh">{longDay(sel)}</h2>
          <p className="rp-lede">{dayLede(p)}</p>
        </div>
        <Sec title={`You owe · ${owe.length}`}>
          <IRows rows={owe.map((i) => itemLine(i, ctx, ihref(i.id), { small: view === "brief" ? "meeting" : "none", badge: p.late.includes(i) ? undefined : i.status === "done" ? undefined : "New" }))} empty="Nothing new to do from this day." />
        </Sec>
        <Sec title={`Decided · ${p.decisions.length}`}>
          <IRows rows={p.decisions.map((i) => itemLine(i, ctx, ihref(i.id), { small: view === "brief" ? "quote" : "none" }))} empty="Nothing was decided." />
        </Sec>
        {view === "brief" && raw ? <Sec title="As it was sent"><pre className="rp-md">{raw}</pre></Sec> : null}
      </div>
    );
    const ec = await editorContext(user);
    const noteCol = (
      <div className="rp-ncol">
        <div className="rp-props">
          <span>Your note</span>
          <span>Saved to <b>{sel}.md</b></span>
          {p.meetings.length ? <span>Links to <b>{p.meetings.map((m) => m.title || "Meeting").slice(0, 2).join(", ")}{p.meetings.length > 2 ? ` +${p.meetings.length - 2}` : ""}</b></span> : null}
        </div>
        <DayNotes key={sel} date={sel} initial={note.notes} title="Notes" {...ec} />
        <p className="rp-note">Type /owe or /waiting and it joins your list, like a promise from a meeting. /todo, /decision and [[ for a link work too.</p>
        <Backlinks day={sel} />
      </div>
    );
    detail = (
      <div className="rp-wrap">
        <DetailBar
          crumb={[{ label: "Daily briefs", href: "/day" }, { label: longDay(sel).replace(/^(\w{3})\w*, (\d+) (\w{3})\w*$/, "$1 $2 $3") }]}
          listHref="/day"
          acts={<>
            <Seg label="Show" items={[{ label: "Brief", href: href(sel, "brief"), on: view === "brief" }, { label: "Brief + note", href: href(sel), on: view === "both" }, { label: "Note", href: href(sel, "note"), on: view === "note" }]} />
            <ExportMenu type="day" id={sel} label="Export" />
          </>}
        />
        <div className={`rp-two${view === "both" ? "" : " rp-two--one"}`}>
          {view !== "note" ? brief : null}
          {view !== "brief" ? noteCol : null}
        </div>
      </div>
    );
  }

  return <Shell current={sel ?? "day"} list={list} detail={detail} show={picked ? "detail" : "list"} />;
}

export function viewOf(v: string | undefined): BriefView {
  return v === "brief" || v === "note" ? v : "both";
}
