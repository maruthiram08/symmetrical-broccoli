import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Section } from "@/components/BriefList";
import { Bar, CrumbLine, ItemDetail } from "@/components/reading/ItemDetail";
import { ItemList, MenuLink } from "@/components/reading/ListPane";
import { personGroups } from "@/lib/reading/model";
import { Shell } from "@/components/Shell";
import { Backlinks } from "@/components/Backlinks";
import { LocalGraph } from "@/components/graph/LocalGraph";
import { initials, listPeople, normalizeName, ownsItem, personDetail, personSlug } from "@/lib/people";
import { getStore, me } from "@/server/local/app";
import { PersonManage, type ManageTarget } from "@/components/PersonManage";
import { UnknownPerson } from "@/components/UnknownPerson";
import { isSpeakerLabel } from "@/lib/directory/speakers";
import { localDate } from "@/lib/brief/time";
import { isSnoozed, starredFirst } from "@/lib/capture/items";
import { pastDays } from "../../_lib/days";
import { loadAll, shortDate } from "../../_lib/lines";
import { groupIds, groupOf, readingCtx, withParams } from "../../_lib/reading";

export const dynamic = "force-dynamic";

/** The slug, written as a name ("nitin-kumar" → "Nitin Kumar"); the page itself shows the stored spelling. */
export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
  const slug = decodeURIComponent((await params).name);
  return { title: slug.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Person" };
}

/** "nitin-kumar" -> "Nitin Kumar" (a slug keeps no case; the page lets you fix the spelling). */
function nameFromSlug(slug: string): string {
  return slug.split(/[-\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ").slice(0, 80);
}

// One person: what you owe them, what they owe you, what closed, what was decided with them, and when you met.
export default async function Person({ params, searchParams }: { params: Promise<{ name: string }>; searchParams: Promise<{ merged?: string; item?: string; about?: string; undo?: string; was?: string }> }) {
  const { name } = await params;
  const sp = await searchParams;
  const { merged } = sp;
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings, people } = await loadAll(user);
  const input = { items, meetings, now, self: [user.name, ...user.aliases], people };
  const found = personDetail(name, input);
  if (!found) {
    // A [[person:X]] link (or an old URL) for a name nobody has: offer to add them or say who it is.
    const shown = nameFromSlug(decodeURIComponent(name));
    if (!shown) notFound();
    const known = listPeople(input).sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.personId ? `p:${p.personId}` : `n:${p.slug}`, label: p.personId ? p.name : `${p.name} (not checked)`, slug: p.slug, ref: p.personId ? { personId: p.personId } : { name: p.name } }));
    return (
      <Shell days={await pastDays(user.id, "")} current="people" openCount={items.filter((i) => i.status === "open" && i.kind !== "decision").length}>
        <p className="db-crumb"><Link className="db-link" href="/people">People</Link></p>
        <h1 className="db-title db-person-title">
          <span className="db-avatar db-avatar--lg" aria-hidden="true">{initials(shown)}</span>
          {shown}
        </h1>
        <UnknownPerson name={shown} speaker={isSpeakerLabel(shown)} targets={known} />
        <Backlinks person={{ name: shown, slug: personSlug(shown), keys: [normalizeName(shown)], spellings: [shown] }} people={people} />
      </Shell>
    );
  }
  // Snoozed items wait for their day; starred ones go first.
  const today = localDate(now, user.timeZone);
  const d = found;
  const snoozed = [...found.youOwe, ...found.waitingOn].filter((i) => isSnoozed(i, today));
  if (decodeURIComponent(name) !== d.person.slug) redirect(`/people/${encodeURIComponent(d.person.slug)}?${new URLSearchParams(Object.entries(sp).filter((e): e is [string, string] => typeof e[1] === "string")).toString()}`);
  const awakeFirst = (xs: typeof found.youOwe) => [...starredFirst(xs.filter((i) => !isSnoozed(i, today))), ...xs.filter((i) => isSnoozed(i, today)).sort((a, b) => (a.snoozedUntil ?? "").localeCompare(b.snoozedUntil ?? ""))];

  // other spellings worth showing: not just a change of case
  const aka = d.person.spellings.filter((x) => normalizeName(x) !== normalizeName(d.person.name));
  const base = `/people/${d.person.slug}`;
  const s = d.summary;
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
  const nothing = !theirItems.length && !d.decisions.length && !d.meetings.length;
  const undo = merged ? (await getStore().listPeopleChanges(user.id)).find((c) => c.id === merged && !c.undone) : undefined;
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const facts = [
    s.youOwe ? `You owe ${n(s.youOwe, "thing")}` : null,
    s.theyOwe ? `${n(s.theyOwe, "thing")} owed to you` : null,
    s.overdue ? `${s.overdue} late` : null,
    snoozed.length ? `${snoozed.length} snoozed` : null,
    s.meetingCount ? `${n(s.meetingCount, "meeting")} together` : null,
  ].filter(Boolean).join(" · ");

  const ctx = readingCtx(user, meetings, now);
  const groups = personGroups(d.person.name, { youOwe: awakeFirst(d.youOwe), waitingOn: awakeFirst(d.waitingOn), decisions: d.decisions, closed: d.closed }, ctx);
  const href = (id: string) => withParams(base, { item: id });
  const about = sp.about === "1" || nothing || !!merged;
  const chosen = !about && sp.item ? items.find((i) => i.id === sp.item) : undefined;
  const firstId = groups.find((g) => g.rows.length)?.rows[0]?.id;
  const selected = about ? undefined : chosen ?? (firstId ? items.find((i) => i.id === firstId) : undefined);
  const kept = d.closed.length;

  const profile = (
    <div className="rp-wrap">
      <Bar className="rp-bar--det"><CrumbLine crumb={{ page: "People", pageHref: "/people", group: d.person.name }} /></Bar>
      <div className="rp-dbody rp-dbody--one">
        <div className="rp-main rp-legacy">
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
          {nothing ? <p className="nr-noitems">No items yet. When a meeting names {d.person.name}, what you owe each other shows up here.</p> : null}
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
          <Backlinks person={d.person} people={people} />
          <LocalGraph user={user} center={`person:${d.person.slug}`} />
        </div>
      </div>
    </div>
  );

  return (
    <Shell
      days={await pastDays(user.id, "")}
      current="people"
      reading={{ groups: groupIds(groups), param: "item", selected: selected?.id ?? null, auto: !chosen, clear: ["about"] }}
      list={
        <ItemList
          title={d.person.name}
          count={`${s.youOwe + s.theyOwe} open · ${kept} kept`}
          add={`${d.person.name.split(/\s+/)[0]} `}
          options={<>
            <MenuLink href={withParams(base, { about: "1" })} on={about}>Profile, meetings and names</MenuLink>
            <MenuLink href="/people">Everyone</MenuLink>
          </>}
          groups={groups}
          hrefBase={base}
          undo={{ id: sp.undo, was: sp.was, back: withParams(base, { item: sp.item }) }}
          top={<Link className="rp-ptop" href={withParams(base, { about: "1" })} aria-current={about ? "page" : undefined}>
            <span className="rp-pcard__av" aria-hidden="true">{initials(d.person.name)}</span>
            <span><b>{facts || "Nothing open."}</b><span>Profile, meetings, merge and split</span></span>
          </Link>}
        />
      }
      detail={selected ? (
        <ItemDetail item={selected} items={items} meetings={meetings} user={user} now={now}
          crumb={{ page: d.person.name, pageHref: withParams(base, { about: "1" }), group: groupOf(groups, selected.id) }}
          inPane selfHref={href(selected.id)} itemHref={href} />
      ) : profile}
    />
  );
}
