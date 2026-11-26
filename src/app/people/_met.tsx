// People in the reading pane: everyone with something open, by how often you've met since. The
// detail shows each open item with a dot per meeting held since it was said, and an update ready to
// send. "Met" counts a meeting where an item names them (Wispr Flow sends no attendee lists).
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Chips, Detail, DetailBar, Head, initials, Kv, LinkGroups, ListBar, MList, NoneDetail, Ppl, RailCard, Sec, type LinkGroup } from "@/components/reading/Frame";
import { CopyButton, UpdateButton, UpdateDraft } from "@/components/reading/MetActions";
import { confirmed } from "@/lib/directory/directory";
import { namesToCheck } from "@/lib/directory/review";
import { normalizeName } from "@/lib/people";
import { meetingsSince, metGroups, metLate, metLede, metLine, sinceLabel, updateTemplate, type MetPerson } from "@/lib/reading/met";
import { lateMinutes, shortDay } from "@/lib/reading/model";
import type { Item } from "@/lib/types";
import { me } from "@/server/local/app";
import { projectRows } from "@/server/structure/notes";
import { loadAll } from "../_lib/lines";
import { loadThreads } from "../_lib/threads";

const MAX_DOTS = 12;
const GROUPS = [
  { key: "since", label: "Met since, still open", short: "Met since" },
  { key: "quiet", label: "Gone quiet", short: "Gone quiet" },
  { key: "week", label: "This week", short: "This week" },
] as const;

export async function MetPeople({ pick }: { pick: string | null }) {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const tz = user.timeZone;
  const { items, meetings, people: dir } = await loadAll(user);
  const self = [user.name, ...user.aliases];
  const input = { items, meetings, now, self, people: dir };
  const g = metGroups(input, tz);
  const all = [...g.since, ...g.quiet, ...g.week];
  const short = (iso: string) => shortDay(iso, tz);
  const href = (p: MetPerson) => `/people?p=${encodeURIComponent(p.person.slug)}`;
  const toCheck = namesToCheck({ items, meetings, people: confirmed({ people: dir, moved: {} }), self }, 0).length;

  const groups: LinkGroup[] = GROUPS.map((x) => ({
    key: x.key, label: x.label,
    rows: g[x.key].map((p) => ({ key: p.person.slug, href: href(p), title: p.person.name, av: initials(p.person.name), sub: metLine(p, short), badge: `${p.ageDays}d`, late: metLate(p) })),
    empty: x.key === "since" ? "No one you've met again with something still open." : x.key === "quiet" ? "No one has gone quiet." : "Nothing new this week.",
  }));
  const sel = pick ? all.find((p) => p.person.slug === pick) ?? null : all[0] ?? null;
  const list = (
    <>
      <ListBar title="People" count={`${all.length} with something open`}>
        <Link className="rp-btn" href="/people?view=all">Everyone</Link>
      </ListBar>
      <Chips chips={[
        ...GROUPS.map((x) => ({ label: x.short, n: g[x.key].length, href: `#rp-g-${x.key}` })),
        ...(toCheck ? [{ label: "to check", n: toCheck, href: "/people/review" }] : []),
      ]} />
      <LinkGroups groups={groups} sel={sel?.person.slug} />
    </>
  );

  let detail;
  if (!sel) detail = <NoneDetail crumb={[{ label: "People" }]} listHref="/people" text="Nothing open with anyone. People show up here once a meeting names them." />;
  else {
    const p = sel;
    const first = p.person.name.split(/\s+/)[0];
    const byId = new Map(meetings.map((m) => [m.id, m]));
    const saidAt = (i: Item) => byId.get(i.meetingId)?.startedAt ?? i.createdAt;
    const kept = p.items.filter((i) => i.status === "done").length;
    const late = p.open.filter((i) => lateMinutes(i, now) !== null).length;
    const oweFirst = [...p.open].sort((a, b) => Number(a.kind !== "owe") - Number(b.kind !== "owe") || saidAt(a).localeCompare(saidAt(b)));
    const aka = p.person.spellings.filter((x) => normalizeName(x) !== normalizeName(p.person.name));
    // Threads with them: your projects and found threads their items are in, with what's open.
    const titles = new Map(projectRows().map((r) => [r.slug, r.title]));
    const projects = new Map<string, number>();
    for (const i of p.items) if (i.project && titles.has(i.project)) projects.set(i.project, (projects.get(i.project) ?? 0) + Number(i.status === "open" && i.kind !== "decision"));
    const found = loadThreads(user, items, meetings, dir, now).filter((t) => t.people.some((x) => x.name === p.person.name));
    const threads = [
      ...[...projects].map(([slug, n]) => ({ key: `p:${slug}`, label: titles.get(slug)!, right: `${n} open`, href: `/projects?project=${encodeURIComponent(slug)}` })),
      ...found.map((t) => ({ key: t.id, label: t.name, right: `${t.people.find((x) => x.name === p.person.name)?.open ?? 0} open`, href: `/projects?project=${encodeURIComponent(`thread:${t.id}`)}` })),
    ].slice(0, 6);
    const oldestOwe = p.open.find((i) => i.kind === "owe");
    const agenda = [`For our next call with ${first}:`, ...oweFirst.map((i) => `• ${i.text}`)].join("\n");
    const pos = all.indexOf(p) + 1;
    const total = Math.max(1, kept + p.open.length);
    detail = (
      <Detail
        bar={<DetailBar crumb={[{ label: "People", href: "/people" }, { label: p.person.name }]} listHref="/people" acts={<>
          <span className="rp-pos">{pos} of {all.length}</span>
          <Link className="rp-btn" href={`/people/${encodeURIComponent(p.person.slug)}`}>All items</Link>
        </>} />}
        rail={<>
          <Sec title={`Your record with ${first}`}>
            <div className="rp-meter rp-meter--big" aria-hidden="true">
              <span className="rp-meter__k" style={{ flex: kept / total }} />
              <span className="rp-meter__o" style={{ flex: (p.open.length - late) / total }} />
              <span className="rp-meter__l" style={{ flex: late / total }} />
            </div>
            <Kv rows={[
              ["Kept", kept], ["Open", p.open.length - late], ["Late", late],
              ["Meetings", p.met[0] ? `${p.met.length} since ${short(p.met[0].startedAt)}` : "None"],
              ["Last met", p.lastMet ? short(p.lastMet) : "Never"],
            ]} />
          </Sec>
          <Sec title={`Threads with ${first}`}><MList rows={threads} empty="Not in any project or thread yet." /></Sec>
          <Sec title="Also heard as"><Ppl names={aka} empty="One spelling so far." /></Sec>
          <RailCard title="How “met” is counted" link={{ href: "/people/review", label: "Check names" }}>
            A meeting counts when an item from it names {first}. Wispr Flow sends no attendee lists for your meetings, so a call where nothing was promised doesn&apos;t count.
          </RailCard>
        </>}
      >
        <Head
          kind={<><span className="rp-av rp-av--sm" aria-hidden="true">{initials(p.person.name)}</span>Person</>}
          st={[{ text: `${p.open.length} open`, late: metLate(p) }]}
          title={p.person.name} big
          lede={metLede(p, short)}
          cta={<>
            <UpdateButton name={first} />
            <CopyButton text={agenda} label="Bring to next call" />
            <Link className="rp-cbtn" href={`/people/${encodeURIComponent(p.person.slug)}`}>Close what&apos;s done</Link>
          </>}
        />
        <Sec title="Still open, and how many times you've met since" right="One dot = one meeting">
          <div className="rp-irows">
            {oweFirst.map((i) => {
              const k = meetingsSince(i, p.met, byId).length;
              const lm = lateMinutes(i, now);
              const lateDays = lm !== null ? Math.max(1, Math.floor(lm / 1440)) : null;
              const red = lateDays !== null || k >= 5;
              const m = byId.get(i.meetingId);
              return (
                <Link key={i.id} className="rp-ms" href={`/people/${encodeURIComponent(p.person.slug)}?item=${encodeURIComponent(i.id)}`}>
                  <span className={`rp-m rp-m--${lateDays !== null ? "late" : i.kind}`} aria-hidden="true" />
                  <span className="rp-ms__t"><span>{i.text}</span><small>{i.kind === "waiting" ? `${first} owes you · ` : ""}Said {short(saidAt(i))}{m?.title ? ` · ${m.title}` : ""}</small></span>
                  <span className="rp-dots" aria-label={`${k} meetings since`}>
                    <span className="rp-dots__r" aria-hidden="true">{Array.from({ length: Math.min(MAX_DOTS, k) }, (_, n) => <i key={n} className={red ? "rp-dots--l" : undefined} />)}</span>
                    <em className={red ? "rp-late" : undefined}>{sinceLabel(k, lateDays)}</em>
                  </span>
                </Link>
              );
            })}
          </div>
        </Sec>
        <Sec title="Update, ready to send">
          <UpdateDraft slug={p.person.slug} template={updateTemplate(p.person.name, oweFirst)} drop={oldestOwe ? { id: oldestOwe.id, label: shortLabel(oldestOwe.text) } : undefined} />
        </Sec>
      </Detail>
    );
  }
  return <Shell current="people" list={list} detail={detail} show={pick ? "detail" : "list"} />;
}

/** "Drop the API one": a few words of the item. */
function shortLabel(text: string): string {
  const w = text.replace(/[.,:;].*$/, "").split(/\s+/);
  return w.length <= 4 ? `“${w.join(" ")}”` : `“${w.slice(0, 4).join(" ")}…”`;
}
