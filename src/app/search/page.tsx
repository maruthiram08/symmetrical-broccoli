import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Highlight } from "@/components/Highlight";
import { Mark } from "@/components/Mark";
import { Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { buildIndex, search, terms, type SearchHit } from "@/lib/search";
import { me } from "@/server/local/app";
import { pastDays } from "../_lib/days";
import { loadAll, shortDate } from "../_lib/lines";
import { personHref } from "../_lib/links";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ q?: string }> }): Promise<Metadata> {
  const q = (await searchParams).q?.trim();
  return { title: q ? `“${q}”` : "Search" };
}

const LIMIT = 50;

// Search item text, quotes, people and meeting titles, open and closed.
export default async function Search({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const q = ((await searchParams).q ?? "").slice(0, 200).trim();
  const { items, meetings } = await loadAll(user);
  const hits = q ? search(buildIndex(items, meetings), q, LIMIT * 2) : [];
  const found = hits.filter((h): h is Extract<SearchHit, { type: "item" }> => h.type === "item").slice(0, LIMIT);
  const met = hits.filter((h): h is Extract<SearchHit, { type: "meeting" }> => h.type === "meeting").slice(0, 20);
  const ws = terms(q);
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;

  return (
    <Shell days={await pastDays(user.id, "")} current="search" openCount={openCount} query={q}>
      <h1 className="db-title">{q ? <>Results for &ldquo;{q}&rdquo;</> : "Search"}</h1>
      <p className="db-subtitle">
        {!q
          ? "Search what was said, who said it, and which meeting it was in."
          : found.length + met.length
            ? `${found.length}${found.length === LIMIT ? "+" : ""} ${found.length === 1 ? "item" : "items"} and ${met.length} ${met.length === 1 ? "meeting" : "meetings"}, best match first.`
            : "Nothing matches. Try fewer words, or part of a name."}
      </p>
      {q ? (
        <>
          <Section title="Items" count={found.length ? String(found.length) : undefined} empty="No items match.">
            {found.map((h) => <ItemHit key={h.id} h={h} q={ws} tz={user.timeZone} />)}
          </Section>
          {met.length ? (
            <Section title="Meetings" count={String(met.length)}>
              {met.map((h) => (
                <div key={h.id} className="db-item db-hit">
                  <span className="db-item__icon"><span className="db-mark db-mark--meeting" aria-hidden="true" /></span>
                  <span className="db-item__text"><Highlight text={h.title} q={ws} /></span>
                  <span className="db-item__side"><span className="db-item__time">{shortDate(h.at, user.timeZone)}</span></span>
                  {h.participants.length ? (
                    <span className="db-item__meta">
                      <span className="db-item__src">With <Highlight text={h.participants.join(", ")} q={ws} /></span>
                    </span>
                  ) : null}
                </div>
              ))}
            </Section>
          ) : null}
        </>
      ) : null}
    </Shell>
  );
}

function ItemHit({ h, q, tz }: { h: Extract<SearchHit, { type: "item" }>; q: string[]; tz: string }) {
  const closed = h.status === "done";
  const kindWord = h.kind === "owe" ? "You owe" : h.kind === "waiting" ? "Waiting on" : "Decision";
  return (
    <div className={`db-item db-hit db-item--${closed ? "done" : h.kind}`}>
      <span className="db-item__icon"><Mark kind={closed ? "done" : h.kind} /></span>
      <span className="db-item__text"><Highlight text={h.text} q={q} /></span>
      <span className="db-item__side"><span className="db-item__time">{shortDate(h.at, tz)}</span></span>
      <span className="db-item__meta">
        <span className="db-hit__kind">{closed ? "Closed" : kindWord}</span>
        {h.person ? (
          <span className="db-item__src">· <Link className="db-plink" href={personHref(h.person)}><Highlight text={h.person} q={q} /></Link></span>
        ) : null}
        <span className="db-item__quote">&ldquo;<Highlight text={h.quote} q={q} />&rdquo;</span>
        {h.meetingTitle ? <span className="db-item__src">· <Highlight text={h.meetingTitle} q={q} /></span> : null}
      </span>
      {closed && h.closeQuote ? (
        <span className="db-item__evidence">Closed: &ldquo;<Highlight text={h.closeQuote} q={q} />&rdquo;</span>
      ) : null}
    </div>
  );
}
