import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BriefItem, ClosedItem, Section } from "@/components/BriefList";
import { Mark } from "@/components/Mark";
import { Shell } from "@/components/Shell";
import { initials, normalizeName, personDetail } from "@/lib/people";
import { me } from "@/server/local/app";
import { pastDays } from "../../_lib/days";
import { loadAll, shortDate, toClosedLine, toLine } from "../../_lib/lines";

export const dynamic = "force-dynamic";

/** The slug, written as a name ("nitin-kumar" → "Nitin Kumar"); the page itself shows the stored spelling. */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const slug = decodeURIComponent((await params).name);
  return { title: slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Person" };
}

// One person: what you owe them, what they owe you, what closed, what was decided with them, and when you met.
export default async function Person({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings } = await loadAll(user);
  const d = personDetail(name, { items, meetings, now, self: [user.name, ...user.aliases] });
  if (!d) notFound();
  if (decodeURIComponent(name) !== d.person.slug) redirect(`/people/${encodeURIComponent(d.person.slug)}`);

  // other spellings worth showing: not just a change of case
  const aka = d.person.spellings.filter((x) => normalizeName(x) !== normalizeName(d.person.name));
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const back = `/people/${d.person.slug}`;
  const s = d.summary;
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const facts = [
    s.youOwe ? `You owe ${n(s.youOwe, "thing")}` : null,
    s.theyOwe ? `${n(s.theyOwe, "thing")} owed to you` : null,
    s.overdue ? `${s.overdue} late` : null,
    s.meetingCount ? `${n(s.meetingCount, "meeting")} together` : null,
  ].filter(Boolean).join(" · ");

  return (
    <Shell days={await pastDays(user.id, "")} current="people" openCount={openCount}>
      <p className="db-crumb"><Link className="db-link" href="/people">People</Link></p>
      <h1 className="db-title db-person-title">
        <span className="db-avatar db-avatar--lg" aria-hidden="true">{initials(d.person.name)}</span>
        {d.person.name}
      </h1>
      <p className="db-subtitle">
        {facts || "Nothing open."}
        {aka.length ? <span className="db-person-aka"> · Also written {aka.join(", ")}</span> : null}
      </p>

      <Section title="You owe" count={d.youOwe.length ? String(d.youOwe.length) : undefined} empty={`Nothing owed to ${d.person.name}.`}>
        {d.youOwe.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
      </Section>
      <Section title="Waiting on" count={d.waitingOn.length ? String(d.waitingOn.length) : undefined} empty={`${d.person.name} owes you nothing.`}>
        {d.waitingOn.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
      </Section>
      {d.closed.length ? (
        <Section title="Closed recently" count={String(d.closed.length)}>
          {d.closed.map((i) =>
            i.closeQuote ? (
              <ClosedItem key={i.id} line={toClosedLine(i, byId, user)} />
            ) : (
              <div key={i.id} className="db-item db-item--done">
                <span className="db-item__icon"><Mark kind="done" /></span>
                <span className="db-item__text">{i.text}</span>
                <span className="db-item__side" />
                <span className="db-item__evidence">You marked it done{i.closedAt ? `, ${shortDate(i.closedAt, user.timeZone)}` : ""}.</span>
              </div>
            ),
          )}
        </Section>
      ) : null}
      <Section title="Decisions" count={d.decisions.length ? String(d.decisions.length) : undefined} empty="No decisions from meetings together.">
        {d.decisions.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
      </Section>
      <Section title="Meetings" count={d.meetings.length ? String(d.meetings.length) : undefined} empty="No meetings found.">
        {d.meetings.length ? <ul className="db-meetings">
          {d.meetings.map((m) => (
            <li key={m.id} className="db-meetings__row">
              <span className="db-meetings__date">{shortDate(m.startedAt, user.timeZone)}</span>
              <span className="db-meetings__title">{m.title}</span>
              <span className="db-meetings__time">{new Intl.DateTimeFormat("en-US", { timeZone: user.timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(m.startedAt))}</span>
            </li>
          ))}
        </ul> : null}
      </Section>
    </Shell>
  );
}
