import Link from "next/link";
import { Section } from "@/components/BriefList";
import { Stats } from "@/components/CloseWrap";
import { Mark } from "@/components/Mark";
import { personSlug } from "@/lib/people";
import { durationLabel, keptRate, type Review, type ReviewItem } from "@/lib/review/review";

function day(iso: string, tz: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });
}

function Row({ i, right, tz, quotes }: { i: ReviewItem; right: string; tz: string; quotes: boolean }) {
  return (
    <div className={`db-item db-item--${i.stillOpen ? i.kind : "done"}`}>
      <span className="db-item__icon"><Mark kind={i.stillOpen ? i.kind : "done"} /></span>
      <span className="db-item__text"><Link className="rv-plain" href={`/item/${encodeURIComponent(i.id)}`}>{i.text}</Link></span>
      <span className="db-item__side"><span className={i.stillOpen ? "db-item__late" : "db-item__time"}>{right}</span></span>
      <span className="db-item__meta">
        {quotes && i.quote ? <span className="db-item__quote">&ldquo;{i.quote}&rdquo;</span> : null}
        <span className="db-item__src">{quotes && i.quote ? "· " : ""}{i.person ? `${i.person} · ` : ""}{i.meetingTitle}, {day(i.madeAt, tz)}</span>
      </span>
    </div>
  );
}

/** One review page body: stats, people, decisions chart, longest open, fastest closed. */
export function ReviewView({ r, tz, quotes, base, current }: { r: Review; tz: string; quotes: boolean; base: string; current: { month: string; year: string } }) {
  const c = r.counts;
  const rate = keptRate(c);
  const max = Math.max(1, ...r.decisionsBy.map((d) => d.count));
  const kindPath = r.period.kind === "year" ? "/review/year" : "/review/month";
  const q = quotes ? "?quotes=1" : "";
  const isFuture = r.period.kind === "year" ? r.period.next > current.year : r.period.next > current.month;
  return (
    <>
      <h1 className="db-title">{r.period.kind === "year" ? `${r.period.label} in review` : `${r.period.label} review`}</h1>
      <p className="db-subtitle">
        {c.meetings} meeting{c.meetings === 1 ? "" : "s"} · {rate === null ? "no promises made" : `${rate}% of promises kept`}
      </p>
      <nav className="rv-bar" aria-label="Review">
        <Link className="cw-pill" href={`${kindPath}/${r.period.prev}${q}`} aria-label="Previous">←</Link>
        {isFuture ? null : <Link className="cw-pill" href={`${kindPath}/${r.period.next}${q}`} aria-label="Next">→</Link>}
        <Link className="cw-pill" href={`/review/month/${current.month}`} aria-current={r.period.kind === "month" ? "page" : undefined}>Month</Link>
        <Link className="cw-pill" href={`/review/year/${r.period.kind === "year" ? r.period.key : r.period.key.slice(0, 4)}`} aria-current={r.period.kind === "year" ? "page" : undefined}>Year</Link>
        <span className="rv-bar__gap" />
        <Link className="cw-pill" href={`${base}${quotes ? "" : "?quotes=1"}`} title="Quotes are left out of the page and the download unless you include them">
          {quotes ? "Hide quotes" : "Include quotes"}
        </Link>
        <a className="db-act db-act--primary rv-download" href={`/api/review/${r.period.kind}/${r.period.key}${quotes ? "?quotes=1" : ""}`} download>
          Download HTML
        </a>
      </nav>

      <Stats items={[
        { label: "Promises made", value: c.made },
        { label: "Kept", value: c.kept },
        { label: "Late", value: c.late, late: true },
        { label: "Closed by meetings", value: c.closedByMeetings },
      ]} />
      <p className="rv-more db-mono">{c.waiting} waiting on others · {c.decisions} decisions · {c.closed} closed in all</p>

      <Section title="People you promised most" empty={`No promises to anyone this ${r.period.kind}.`}>
        {r.people.map((p) => (
          <div key={p.slug} className="cw-person">
            <Link className="cw-person__name rv-plain" href={`/people/${personSlug(p.name)}`}>{p.name}</Link>
            <span className="cw-person__n">{p.made} made · {p.kept} kept{p.open ? ` · ${p.open} open` : ""}</span>
          </div>
        ))}
      </Section>

      <Section title={`Decisions by ${r.period.kind === "year" ? "month" : "week"}`} count={c.decisions ? String(c.decisions) : undefined}>
        <div className="rv-bars" role="img" aria-label={r.decisionsBy.map((d) => `${d.label}: ${d.count}`).join(", ")}>
          {r.decisionsBy.map((d) => (
            <div key={d.key} className="rv-bar1">
              <em>{d.count || ""}</em>
              <i style={{ height: `${Math.round((d.count / max) * 90)}%` }} />
              <span>{d.label}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Longest open" empty="Nothing to show.">
        {r.longestOpen.map((i) => <Row key={i.id} i={i} tz={tz} quotes={quotes} right={`${durationLabel(i.openMinutes)}${i.stillOpen ? " open" : ""}`} />)}
      </Section>
      <Section title="Fastest closed" empty="Nothing closed yet.">
        {r.fastestClosed.map((i) => <Row key={i.id} i={i} tz={tz} quotes={quotes} right={durationLabel(i.openMinutes)} />)}
      </Section>
    </>
  );
}
