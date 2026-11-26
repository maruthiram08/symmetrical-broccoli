import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BriefItem, ClosedItem, Section } from "@/components/BriefList";
import { Mark } from "@/components/Mark";
import { Shell } from "@/components/Shell";
import { initials, listPeople, normalizeName, ownsItem, personDetail } from "@/lib/people";
import { getStore, me } from "@/server/local/app";
import { PersonManage, type ManageTarget } from "@/components/PersonManage";
import { localDate } from "@/lib/brief/time";
import { isSnoozed, starredFirst } from "@/lib/capture/items";
import { pastDays } from "../../_lib/days";
import { loadAll, shortDate, toClosedLine, toLine } from "../../_lib/lines";

export const dynamic = "force-dynamic";

/** The slug, written as a name ("nitin-kumar" → "Nitin Kumar"); the page itself shows the stored spelling. */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const slug = decodeURIComponent((await params).name);
  return { title: slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Person" };
}

// One person: what you owe them, what they owe you, what closed, what was decided with them, and when you met.
export default async function Person({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ merged?: string }> }) {
  const { name } = await params;
  const { merged } = await searchParams;
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings, people } = await loadAll(user);
  const input = { items, meetings, now, self: [user.name, ...user.aliases], people };
  const found = personDetail(name, input);
  if (!found) notFound();
  // Snoozed items wait for their day; starred ones go first.
  const today = localDate(now, user.timeZone);
  const awake = (xs: typeof found.youOwe) => starredFirst(xs.filter((i) => !isSnoozed(i, today)));
  const d = { ...found, youOwe: awake(found.youOwe), waitingOn: awake(found.waitingOn) };
  if (decodeURIComponent(name) !== d.person.slug) redirect(`/people/${encodeURIComponent(d.person.slug)}`);

  // other spellings worth showing: not just a change of case
  const aka = d.person.spellings.filter((x) => normalizeName(x) !== normalizeName(d.person.name));
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const back = `/people/${d.person.slug}`;
  const s = d.summary;
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;
  const me_ = d.person.personId ? people.find((p) => p.id === d.person.personId) : undefined;
  // Merge and split targets: everyone else on People.
  const targets: ManageTarget[] = listPeople(input)
    .filter((p) => p.slug !== d.person.slug)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => p.personId
      ? { value: `p:${p.personId}`, label: p.name, slug: p.slug, ref: { personId: p.personId } }
      : { value: `n:${p.slug}`, label: `${p.name} (not checked)`, slug: p.slug, ref: { name: p.name } });
  // Split works on every item that names them, open ones first.
  const theirItems = items.filter((i) => i.status !== "wrong" && ownsItem(d.person, i)).sort((a, b) => Number(b.status === "open") - Number(a.status === "open"));
  const undo = merged ? (await getStore().listPeopleChanges(user.id)).find((c) => c.id === merged && !c.undone) : undefined;
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
        {me_?.email ? <span className="db-person-aka"> · {me_.email}</span> : null}
      </p>
      {me_?.note ? <p className="nr-note">{me_.note}</p> : null}
      {!d.person.personId ? (
        <p className="nr-unchecked">
          <span className="nr-check">check</span> This name hasn’t been checked. Is it right? <Link className="db-link" href="/people/review">Check names</Link>
        </p>
      ) : null}

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
      <PersonManage
        key={`${d.person.slug}:${merged ?? ""}`}
        self={d.person.personId ? { personId: d.person.personId } : { name: d.person.name, spellings: d.person.spellings }}
        name={d.person.name}
        personId={d.person.personId}
        email={me_?.email ?? null}
        note={me_?.note ?? null}
        items={theirItems.map((i) => ({ id: i.id, text: i.text, kind: i.kind, status: i.status }))}
        targets={targets}
        undo={undo ? { changeId: undo.id, label: undo.label } : null}
      />
    </Shell>
  );
}
