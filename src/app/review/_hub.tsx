// Review in the reading pane: the list is a hub (what's left to check, then the reports), and the
// detail is the picked month's or year's report.
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Detail, DetailBar, Head, IRows, Kv, LinkGroups, ListBar, MList, RailCard, Sec, Stats, type LinkGroup } from "@/components/reading/Frame";
import { localDate } from "@/lib/brief/time";
import { openMissed } from "@/lib/crosscheck/compare";
import { confirmed } from "@/lib/directory/directory";
import { namesToCheck } from "@/lib/directory/review";
import { countBy } from "@/lib/reading/library";
import { shortDay } from "@/lib/reading/model";
import { currentKeys, durationLabel, keptRate, type PeriodKind, type Review } from "@/lib/review/review";
import type { User } from "@/lib/types";
import { getFileStore, me } from "@/server/local/app";
import { loadReview } from "@/server/local/review";
import { isHosted } from "@/server/mode";
import { loadAll } from "../_lib/lines";

/** What's waiting to be checked: Wispr Flow lines Daily brief missed, and names to confirm. */
export async function reviewTodo(user: User) {
  const { items, meetings, people } = await loadAll(user);
  let missed = 0;
  let gaps = 0;
  if (!isHosted()) {
    const store = getFileStore();
    const recs = (await store.listCrossChecks(user.id)).filter((r) => store.meetings.has(r.meetingId));
    for (const r of recs) { const n = openMissed(r).length; missed += n; if (n) gaps++; }
  }
  const names = namesToCheck({ items, meetings, people: confirmed({ people, moved: {} }), self: [user.name, ...user.aliases] });
  return { missed, gaps, names: names.length, items, meetings };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function ReviewHub({ kind, keyStr, picked }: { kind: PeriodKind; keyStr: string; picked: boolean }) {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const tz = user.timeZone;
  const r = await loadReview(user, kind, keyStr, now);
  if (!r) notFound();
  const prev = await loadReview(user, kind, r.period.prev, now);
  const todo = await reviewTodo(user);
  const cur = currentKeys(now, tz);

  // Months with meetings, newest first, and the years.
  const months = [...new Set(todo.meetings.map((m) => localDate(new Date(m.startedAt), tz).slice(0, 7)))].filter((m) => m <= cur.month).sort().reverse().slice(0, 12);
  if (!months.includes(cur.month)) months.unshift(cur.month);
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse();
  const monthRows = await Promise.all(months.map(async (m) => {
    const x = m === keyStr && kind === "month" ? r : await loadReview(user, "month", m, now);
    return { m, line: x ? `${plural(x.counts.meetings, "meeting")} · ${plural(x.counts.made, "promise")} · ${x.counts.kept} kept` : "" };
  }));
  const groups: LinkGroup[] = [
    {
      key: "check", label: "To check",
      rows: [
        ...(isHosted() ? [] : [{ key: "x", href: "/crosscheck", title: "Cross-check with Wispr Flow", sub: todo.missed ? `${todo.missed} missed in ${plural(todo.gaps, "meeting")}` : "Nothing missing", mark: todo.missed ? "late" : "ring", num: { n: todo.missed, label: "to check" } }]),
        { key: "n", href: "/people/review", title: "Check names", sub: todo.names ? "Names transcription guessed" : "Every name is sorted", mark: "ring", num: { n: todo.names, label: "names" } },
      ],
    },
    {
      key: "reports", label: "Reports",
      rows: [
        ...monthRows.map(({ m, line }) => ({ key: `month:${m}`, href: `/review/month/${m}`, title: r.period.kind === "month" && r.period.key === m ? r.period.label : monthLabel(m), sub: line, badge: m === cur.month ? "This month" : monthLabel(m).slice(0, 3), mark: "dot" })),
        ...years.map((y) => ({ key: `year:${y}`, href: `/review/year/${y}`, title: y === cur.year ? `${y} so far` : y, sub: "The year in one page", badge: "Year", mark: "dot" })),
      ],
    },
  ];
  const sel = `${kind}:${keyStr}`;
  const list = (
    <>
      <ListBar title="Review" count={todo.missed + todo.names ? `${todo.missed + todo.names} to check` : undefined} />
      <LinkGroups groups={groups} sel={sel} limit={14} />
    </>
  );
  return <Shell current="review" list={list} detail={<Report r={r} prev={prev} tz={tz} todo={todo} />} show={picked ? "detail" : "list"} />;
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 15)));
}

function Report({ r, prev, tz, todo }: { r: Review; prev: Review | null; tz: string; todo: Awaited<ReturnType<typeof reviewTodo>> }) {
  const c = r.counts;
  const rate = keptRate(c);
  const prevRate = prev ? keptRate(prev.counts) : null;
  const unit = r.period.kind === "year" ? "year" : "month";
  // Busiest meetings in the period, by how many items they left.
  const inPeriod = todo.meetings.filter((m) => m.startedAt >= r.period.startIso && m.startedAt < r.period.endIso);
  const ids = new Set(inPeriod.map((m) => m.id));
  const busiest = countBy(todo.items.filter((i) => ids.has(i.meetingId) && i.status !== "wrong"), (i) => i.meetingId).slice(0, 3);
  const byId = new Map(inPeriod.map((m) => [m.id, m]));
  const maxP = Math.max(1, ...r.people.map((p) => p.made));
  const keptFor = [...r.people].filter((p) => p.kept).sort((a, b) => b.kept - a.kept).slice(0, 4);
  const last = new Date(Math.min(Date.now(), Date.parse(r.period.endIso) - 1)).toISOString();
  const range = r.period.kind === "month" ? `${shortDay(r.period.startIso, tz).split(" ")[0]} to ${shortDay(last, tz)}` : r.period.key;
  const download = `/api/review/${r.period.kind}/${r.period.key}`;
  const was = (n: number | null | undefined, suffix = "") => (prev && n !== null && n !== undefined ? ` (${n}${suffix})` : "");
  return (
    <Detail
      bar={<DetailBar crumb={[{ label: "Review", href: "/review" }, { label: r.period.label }]} listHref="/review"
        acts={<>
          <Link className="rp-btn" href={`/review/${r.period.kind}/${r.period.prev}`}>Previous</Link>
          <a className="rp-btn rp-btn--pri" href={download} download>Export</a>
        </>} />}
      rail={<>
        <Sec title={prev ? `Compared with ${prev.period.label.split(" ")[0]}` : "This " + unit}>
          <Kv rows={[
            ["Meetings", `${c.meetings}${was(prev?.counts.meetings)}`],
            ["Promises", `${c.made}${was(prev?.counts.made)}`],
            ["Kept rate", <span key="k" className={rate !== null && prevRate !== null && rate < prevRate ? "rp-late" : undefined}>{rate === null ? "—" : `${rate}%`}{was(prevRate, "%")}</span>],
            ["Decisions", `${c.decisions}${was(prev?.counts.decisions)}`],
          ]} />
        </Sec>
        <Sec title="Kept most for"><MList rows={keptFor.map((p) => ({ key: p.slug, label: p.name, right: p.kept, href: `/people/${encodeURIComponent(p.slug)}` }))} empty="Nothing kept yet." /></Sec>
        {todo.missed ? <RailCard title={`${todo.missed} lines to cross-check`} link={{ href: "/crosscheck", label: "Start checking" }}>Wispr Flow heard things Daily brief missed. Checking them makes this report more accurate.</RailCard> : null}
      </>}
    >
      <Head kind={`${r.period.kind === "year" ? "Year" : "Monthly"} review · ${range}`} title={r.period.label}
        lede={`${plural(c.meetings, "meeting")} this ${unit}. You made ${plural(c.made, "promise")} and kept ${c.kept}${c.late ? `, and ${c.late} ran late` : ""}. ${c.decisions ? `${plural(c.decisions, "thing")} were decided.` : ""}`} />
      <Stats items={[{ n: c.made, label: "Promises made" }, { n: c.kept, label: "Kept" }, { n: c.late, label: "Late", late: !!c.late }, { n: c.decisions, label: "Decisions" }]} />
      <Sec title="Kept rate" right={rate === null ? "No promises yet" : `${rate}%${prevRate !== null ? ` · ${prev!.period.label.split(" ")[0]} was ${prevRate}%` : ""}`}>
        <div className="rp-meter rp-meter--big" aria-hidden="true">
          <span className="rp-meter__k" style={{ width: `${c.made ? (c.kept / c.made) * 100 : 0}%` }} />
          <span className="rp-meter__o" style={{ width: `${c.made ? (c.late / c.made) * 100 : 0}%` }} />
        </div>
        <div className="rp-legend"><span><i />Kept {c.kept}</span><span><i className="o" />Late {c.late}</span><span>{c.waiting} waiting on others</span></div>
      </Sec>
      <Sec title="Open longest from this period">
        <IRows rows={r.longestOpen.map((i) => ({ key: i.id, href: `/item/${encodeURIComponent(i.id)}`, mark: "late", title: i.text, small: [i.meetingTitle, i.person, shortDay(i.madeAt, tz)].filter(Boolean).join(" · "), badge: durationLabel(i.openMinutes), late: true }))} empty={`Everything from this ${unit} is closed.`} />
      </Sec>
      <Sec title="You owe most to">
        {r.people.length ? (
          <div className="rp-bars">{r.people.slice(0, 6).map((p) => <div key={p.slug}><span>{p.name}</span><i style={{ width: `${(p.made / maxP) * 100}%` }} /><span>{p.made}</span></div>)}</div>
        ) : <p className="rp-quiet">No promises to anyone this {unit}.</p>}
      </Sec>
      <Sec title="Busiest meetings">
        <IRows rows={busiest.map(([id, n]) => ({ key: id, href: `/meeting/${encodeURIComponent(id)}`, mark: "dot", title: byId.get(id)?.title || "Meeting", small: byId.get(id) ? shortDay(byId.get(id)!.startedAt, tz) : "", badge: plural(n, "item") }))} empty="No meetings yet." />
      </Sec>
      {r.fastestClosed.length ? (
        <Sec title="Fastest closed">
          <IRows rows={r.fastestClosed.map((i) => ({ key: i.id, href: `/item/${encodeURIComponent(i.id)}`, mark: "done", title: i.text, small: [i.meetingTitle, i.person].filter(Boolean).join(" · "), badge: durationLabel(i.openMinutes) }))} />
        </Sec>
      ) : null}
    </Detail>
  );
}
