import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NameReview } from "@/components/NameReview";
import { Shell } from "@/components/Shell";
import { Chips, Detail, DetailBar, Head, IRows, Keys, LinkGroups, ListBar, NoneDetail, Sec, initials, type LinkGroup } from "@/components/reading/Frame";
import { confirmed } from "@/lib/directory/directory";
import { namesToCheck, unlabelledSpeakers } from "@/lib/directory/review";
import { UNLABELLED } from "@/lib/directory/speakers";
import { itemLine } from "@/lib/reading/library";
import { shortDay } from "@/lib/reading/model";
import { me } from "@/server/local/app";
import { loadAll, shortDate } from "../../_lib/lines";
import { readingCtx } from "../../_lib/reading";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Check names" };

// Names transcription guessed, one at a time: the same as someone you know, a new person, or not a
// person at all. Every page and future meetings use the answer.
export default async function CheckNames({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const { n: want } = await searchParams;
  const now = new Date();
  const { items, meetings, people } = await loadAll(user);
  const ctx = readingCtx(user, meetings, now);
  const known = confirmed({ people, moved: {} });
  const names = namesToCheck({ items, meetings, people: known, self: [user.name, ...user.aliases] });
  const lastSeen = Object.fromEntries(names.filter((n) => n.lastSeenAt).map((n) => [n.key, shortDate(n.lastSeenAt!, user.timeZone)]));
  const speakers = unlabelledSpeakers(items);
  const match = names.filter((n) => n.suggestions.some((s) => s.personId));
  const fresh = names.filter((n) => !n.suggestions.some((s) => s.personId));
  const sel = names.find((n) => n.key === want) ?? names[0] ?? null;
  const href = (k: string) => `/people/review?n=${encodeURIComponent(k)}`;
  const first = (s: string) => s.split(/\s+/)[0];
  const row = (n: (typeof names)[number]) => {
    const best = n.suggestions.find((s) => s.personId);
    return {
      key: n.key, href: href(n.key), title: n.name, av: initials(n.name), bold: true,
      sub: `Heard ${n.items === 1 ? "once" : `${n.items} times`}${n.quote?.meeting ? ` · last ${n.quote.meeting}` : ""}`,
      badge: best ? `→ ${first(best.name)}` : "New?",
    };
  };
  const groups: LinkGroup[] = [
    { key: "same", label: "Looks like someone you know", rows: match.map(row) },
    { key: "new", label: "New name", rows: fresh.map(row) },
  ].filter((g) => g.rows.length);
  const list = (
    <>
      <ListBar title="Check names" count={names.length || undefined} back={{ href: "/review", label: "Review" }} />
      {names.length ? <Chips chips={[{ label: "Same as someone", n: match.length, href: "#rp-g-same" }, { label: "New", n: fresh.length, href: "#rp-g-new" }]} /> : null}
      <LinkGroups groups={groups} sel={sel?.key} foot={speakers.length ? <>Transcription couldn&apos;t name {speakers.length === 1 ? "one voice" : `${speakers.length} voices`}, so their items show &ldquo;{UNLABELLED}&rdquo;: {speakers.map((s) => `${s.label} (${s.items})`).join(", ")}.</> : names.length ? null : "Every name is checked. New names from meetings show up here."} />
    </>
  );

  let detail;
  if (!sel) detail = <NoneDetail crumb={[{ label: "Review", href: "/review" }, { label: "Check names" }]} listHref="/people/review" text="Every name is checked. New names from meetings show up here." />;
  else {
    const best = sel.suggestions.find((s) => s.personId) ?? null;
    const spell = new Set(sel.spellings.map((s) => s.toLowerCase()));
    const heard = items.filter((i) => i.person && spell.has(i.person.toLowerCase()) && i.status !== "wrong")
      .sort((a, b) => (ctx.meetings.get(b.meetingId)?.startedAt ?? b.createdAt).localeCompare(ctx.meetings.get(a.meetingId)?.startedAt ?? a.createdAt));
    const bestPerson = best ? items.filter((i) => i.personId === best.personId) : [];
    const pos = names.indexOf(sel) + 1;
    detail = (
      <Detail
        bar={<DetailBar crumb={[{ label: "Review", href: "/review" }, { label: "Check names", href: "/people/review" }, { label: sel.name }]} listHref="/people/review" acts={<span className="rp-pos">{pos} of {names.length}</span>} />}
        rail={<>
          <Sec title={best ? "If you say yes" : "What happens"}>
            <p className="rp-note">{best ? `The ${sel.items} item${sel.items === 1 ? "" : "s"} move to ${best.name}'s page, and “${sel.name}” is kept as another name for them, so later meetings file straight there. You can undo it.` : "Pick who it is, make a new person, or say it isn't a person. Later meetings use your answer. You can undo it."}</p>
          </Sec>
          {best?.why.length ? <Sec title="Why we think so"><p className="rp-note">{best.why.join(" · ")}</p></Sec> : null}
          <Keys rows={[["Same as suggestion", "1"], ["Pick someone", "P"], ["New person", "N"], ["Not a person", "I"], ["Undo", "U"]]} />
        </>}
      >
        <Head kind="Heard name" st={[{ text: `${sel.items === 1 ? "once" : `${sel.items} times`}, ${sel.meetings} meeting${sel.meetings === 1 ? "" : "s"}` }]}
          title={best ? <>Is &ldquo;{sel.name}&rdquo; the same person as {best.name}?</> : <>Who is &ldquo;{sel.name}&rdquo;?</>} />
        <div className="rp-pcmp">
          <div className="rp-pcard rp-pcard--heard">
            <div className="rp-pcard__top"><span className="rp-pcard__av">{initials(sel.name)}</span><div><div className="rp-pcard__nm">{sel.name}</div><div className="rp-pcard__ln">Heard name · {sel.items} item{sel.items === 1 ? "" : "s"}</div></div></div>
            {sel.lastSeenAt ? <span className="rp-note">Last heard {shortDay(sel.lastSeenAt, user.timeZone)}{sel.spellings.length > 1 ? ` · also ${sel.spellings.filter((s) => s !== sel.name).join(", ")}` : ""}</span> : null}
          </div>
          <span aria-hidden="true">{best ? "=" : "?"}</span>
          {best ? (
            <div className="rp-pcard">
              <div className="rp-pcard__top"><span className="rp-pcard__av">{initials(best.name)}</span><div><div className="rp-pcard__nm">{best.name}</div><div className="rp-pcard__ln">Person · {bestPerson.length} items · {bestPerson.filter((i) => i.status === "open").length} open</div></div></div>
            </div>
          ) : <div className="rp-pcard"><span className="rp-note">No one you know sounds like this. It may be someone new.</span></div>}
        </div>
        <Sec title="Answer"><NameReview key={sel.key} names={[sel]} people={known.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name))} lastSeen={lastSeen} /></Sec>
        <Sec title={`Where we heard it · ${heard.length}`}>
          <IRows rows={heard.map((i) => itemLine(i, ctx, `/item/${encodeURIComponent(i.id)}`, { small: "quote", badge: shortDay(ctx.meetings.get(i.meetingId)?.startedAt ?? i.createdAt, user.timeZone) }))} empty="No items name them any more." />
        </Sec>
      </Detail>
    );
  }
  return <Shell current="names" list={list} detail={detail} show={want ? "detail" : "list"} />;
}
