import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Section } from "@/components/BriefList";
import { Mark } from "@/components/Mark";
import { PersonPeek } from "@/components/PersonPeek";
import { Shell } from "@/components/Shell";
import { ShareToTeam } from "@/components/ShareToTeam";
import { formatTime } from "@/lib/brief/time";
import { personSlug } from "@/lib/people";
import type { Item, Meeting } from "@/lib/types";
import { relatedItems, timeline, type TimelineEvent } from "@/lib/wow/timeline";
import { me } from "@/server/local/app";
import { pastDays } from "../../_lib/days";
import { TicketLabel, TicketSend } from "@/components/integrations/TicketSlot";
import { loadAll, shortDate } from "../../_lib/lines";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await me();
  const item = user ? (await loadAll(user)).items.find((i) => i.id === decodeURIComponent(id)) : undefined;
  return { title: item?.text ?? "History" };
}

const KIND = { owe: "You owe", waiting: "Waiting on", decision: "Decision" } as const;

// One item's life: when it was promised, mentioned again, due, and how it closed; then related earlier items.
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings } = await loadAll(user);
  const item = items.find((i) => i.id === decodeURIComponent(id));
  if (!item) notFound();
  const self = [user.name, ...user.aliases];
  const events = timeline(item, items, meetings, now, self);
  const related = relatedItems(item, items, meetings, self);
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;
  const tz = user.timeZone;
  const when = (iso: string) => `${shortDate(iso, tz)}, ${formatTime(iso, tz)}`;
  const late = item.status === "open" && item.kind !== "decision" && !!item.dueAt && Date.parse(item.dueAt) < now.getTime();
  const slug = item.person ? personSlug(item.person) : "";
  const status = item.status === "open" ? (item.kind === "decision" ? "Decided" : late ? "Overdue" : "Open") : item.status === "done" ? "Done" : item.status === "inbox" ? "In your Inbox" : "Marked wrong";

  return (
    <Shell days={await pastDays(user.id, "")} current="item" openCount={openCount}>
      <p className="db-crumb">{item.kind !== "decision" && item.status === "open" ? <Link className="db-link" href="/open">All open</Link> : <Link className="db-link" href="/">Today</Link>}</p>
      <h1 className={`db-title w3-item-title w3-item-title--${item.kind}`}>
        <span className="w3-item-title__mark"><Mark kind={late ? "overdue" : item.status === "open" ? item.kind : "done"} /></span>
        <span>{item.text}</span>
      </h1>
      <p className="db-subtitle w3-item-sub">
        <span>{KIND[item.kind]}</span>
        {item.person ? <span>{slug ? <PersonPeek slug={slug}>{item.person}</PersonPeek> : item.person}</span> : null}
        <span className={`w3-status${late ? " w3-status--late" : ""}`}>{status}</span>
        <TicketLabel itemId={item.id} lead="" />
      </p>
      <ShareToTeam itemId={item.id} />
      {item.kind !== "decision" && item.status === "open" ? <div className="int-page-send"><TicketSend itemId={item.id} variant="row" /></div> : null}

      <Section title="Timeline">
        <ol className="w3-tl" aria-label="What happened to this item">
          {events.map((e, k) => <Event key={k} e={e} item={item} when={when} />)}
        </ol>
      </Section>

      <Section title="Related earlier" count={related.length ? String(related.length) : undefined} empty="Nothing earlier looks related.">
        {related.length ? (
          <ul className="w3-rel">
            {related.map((r) => <Related key={r.item.id} item={r.item} meeting={r.meeting} why={r.why} tz={tz} />)}
          </ul>
        ) : null}
      </Section>
    </Shell>
  );
}

function Event({ e, item, when }: { e: TimelineEvent; item: Item; when: (iso: string) => string }) {
  const head = (label: string, at: string | null, extra?: string) => (
    <span className="w3-tl__head">
      <span className="w3-tl__label">{label}</span>
      {at ? <span className="w3-tl__when">{when(at)}</span> : null}
      {extra ? <span className="w3-tl__where">{extra}</span> : null}
    </span>
  );
  switch (e.kind) {
    case "made":
      return (
        <li className={`w3-tl__ev w3-tl__ev--made w3-tl__ev--${item.kind}`}>
          {item.source === "manual" ? (
            <>
              {head("Added by you", e.at, item.kind === "waiting" && item.person ? `${item.person} owes you this` : undefined)}
              {item.note ? <span className="w3-tl__quote">{item.note}</span> : null}
            </>
          ) : <>
          {head(item.kind === "owe" ? "You promised" : item.kind === "waiting" ? `${item.person ?? "They"} promised` : "Decided", e.at, e.meeting?.title)}
          <q className="w3-tl__quote">{e.quote}</q>
          </>}
        </li>
      );
    case "mentioned":
      return (
        <li className="w3-tl__ev">
          {head("Came up again", e.at, e.meeting?.title)}
          <Link className="w3-tl__quote w3-tl__quote--link" href={`/item/${encodeURIComponent(e.itemId)}`}>{e.quote}</Link>
        </li>
      );
    case "due":
      return <li className={`w3-tl__ev${e.passed && item.status === "open" ? " w3-tl__ev--late" : ""}`}>{head(e.passed ? (item.status === "open" ? "Was due" : "Due") : "Due", e.at, e.passed ? undefined : "coming up")}</li>;
    case "closed":
      return (
        <li className="w3-tl__ev w3-tl__ev--end">
          {head("Closed", e.at, e.meeting?.title)}
          <q className="w3-tl__quote">{e.quote}</q>
        </li>
      );
    case "marked":
      return <li className="w3-tl__ev w3-tl__ev--end">{head(e.reason ?? (e.status === "done" ? "You marked it done" : "You marked it wrong"), e.at, e.reason && item.ticket ? item.ticket.key : undefined)}</li>;
    case "open":
      return <li className="w3-tl__ev w3-tl__ev--now">{head("Still open", null, "nothing has closed it yet")}</li>;
  }
}

function Related({ item, meeting, why, tz }: { item: Item; meeting: Meeting | null; why: string; tz: string }) {
  const mark = item.status === "open" ? item.kind : "done";
  return (
    <li>
      <Link className="w3-rel__row" href={`/item/${encodeURIComponent(item.id)}`}>
        <span className="w3-rel__mark"><Mark kind={mark} /></span>
        <span className="w3-rel__text">{item.text}</span>
        <span className="w3-rel__meta">
          {KIND[item.kind]}{meeting ? ` · ${meeting.title}, ${shortDate(meeting.startedAt, tz)}` : ""}{why ? ` · ${why}` : ""}
        </span>
      </Link>
    </li>
  );
}
