import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BriefItem, Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { BulkMove } from "@/components/structure/BulkMove";
import { RefileButton, SuggestedProjects } from "@/components/structure/ProjectFiling";
import type { Item } from "@/lib/types";
import { getFileStore, me } from "@/server/local/app";
import { autoFileProjects, filedByYou, filingProjects, suggestProjects } from "@/server/structure/autofile";
import { projectRows } from "@/server/structure/notes";
import { pastDays } from "../_lib/days";
import { loadAll, shortDate, toLine } from "../_lib/lines";
import { readingCtx } from "../_lib/reading";
import { PaneAlerts } from "@/components/Shell";
import { Bar, CrumbLine, EmptyDetail, ItemDetail } from "@/components/reading/ItemDetail";
import { ListHeader } from "@/components/reading/ListPane";
import { ProjectDetail } from "@/components/reading/ProjectDetail";
import { ProjectList } from "@/components/reading/ProjectList";
import { projectLine, projectSummaries, shortDay } from "@/lib/reading/model";
import { ThreadDetail } from "@/components/reading/ThreadDetail";
import { HiddenFlash } from "@/components/reading/MetActions";
import { getAiStore } from "@/server/local/ai-store";
import { readThreads } from "@/server/local/threads";
import { loadThreads } from "../_lib/threads";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Projects" };

const SUGGEST_DAYS = 45;
const newestFirst = (a: Item, b: Item) => b.createdAt.localeCompare(a.createdAt);

// Two views. By project (default): the projects listed on the left and the picked one on the right
// (?project=<slug>, and ?item=<id> for one of its items), with what's open, decided and the meetings
// that fed it. Filing: your projects, what was filed into them on its own, what still needs a project, and projects worth
// making from the topics your meetings share. Filing runs on load, so a project you just made in a
// note, or new keywords, take effect here.
export default async function Projects({ searchParams }: { searchParams: Promise<{ view?: string; project?: string; item?: string; undo?: string; was?: string; hidden?: string }> }) {
  const sp = await searchParams;
  const view = sp.view === "filing" ? "filing" : "board";
  const user = await me();
  if (!user) redirect("/setup");
  await autoFileProjects(getFileStore(), user.id).catch(() => undefined);
  const { items, meetings, people } = await loadAll(user);
  const now = new Date();
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const live = items.filter((i) => i.status !== "wrong" && i.status !== "inbox");
  const rows = projectRows();
  const open = live.filter((i) => i.status === "open");
  const needs = open.filter((i) => !i.project && !filedByYou(i) && i.projectBy !== "you").sort(newestFirst);
  const auto = open.filter((i) => i.project && i.projectBy === "auto").sort(newestFirst);
  const since = new Date(now.getTime() - SUGGEST_DAYS * 86_400_000).toISOString();
  const topics = suggestProjects(live, meetings, filingProjects(), since);
  const back = view === "filing" ? "/projects?view=filing" : "/projects";
  const tabs = (
    <nav className="rp-tabs" role="tablist" aria-label="Projects view">
      <Link role="tab" aria-selected={view === "board"} className={view === "board" ? "rp-tab rp-tab--on" : "rp-tab"} href="/projects">By project</Link>
      <Link role="tab" aria-selected={view === "filing"} className={view === "filing" ? "rp-tab rp-tab--on" : "rp-tab"} href="/projects?view=filing">Filing{needs.length ? ` · ${needs.length} need a project` : ""}</Link>
    </nav>
  );
  // The list: every project, most active first. The detail: the picked project, or one of its items.
  const ctx = readingCtx(user, meetings, now);
  const summaries = projectSummaries(rows.map((r) => ({ slug: r.slug, title: r.title })), live, meetings);
  const statusOf = (slug: string) => { const st = rows.find((r) => r.slug === slug)?.props.status; return typeof st === "string" ? st : null; };
  // Threads found across your meetings: suggestions only, listed under yours, never filed until Keep.
  const threads = loadThreads(user, items, meetings, people, now);
  const tid = (id: string) => `thread:${id}`;
  const ids = [...summaries.map((x) => x.slug), ...threads.map((t) => tid(t.id))];
  const wanted = sp.project ?? (view === "board" ? ids[0] : undefined);
  const pickThread = wanted?.startsWith("thread:") ? threads.find((t) => tid(t.id) === wanted) : undefined;
  const pick = pickThread ? undefined : summaries.find((x) => x.slug === wanted) ?? (view === "board" && !sp.project ? summaries[0] : undefined);
  const day = (iso: string) => shortDay(iso, user.timeZone);
  const groups = [
    {
      key: "yours", label: "Yours", empty: "No projects yet. Keep a found one, or make one under Filing.",
      rows: summaries.map((x) => ({
        slug: x.slug, title: x.title, line: projectLine(x), open: x.owe.length + x.waiting.length,
        last: x.meetings[0] ? `${x.meetings[0].title || "Meeting"}, ${shortDate(x.meetings[0].startedAt, user.timeZone)}` : "",
      })),
    },
    {
      key: "found", label: "Found in your meetings", empty: "Nothing yet. A thread shows up once four meetings with two or more people share it.",
      rows: threads.map((t) => {
        const lastM = t.meetings[t.meetings.length - 1];
        return {
          slug: tid(t.id), title: t.name, found: true, open: t.open.length,
          line: t.state === "wrapped" ? `All ${t.kept} kept · ${t.meetings.length} meetings` : `${t.open.length} open · ${t.decisions.length} ${t.decisions.length === 1 ? "decision" : "decisions"} · ${t.meetings.length} meetings`,
          last: t.state === "stalled" ? `Stalled since ${day(`${t.lastItem}T12:00:00Z`)}` : `${lastM.title || "Meeting"}, ${day(lastM.startedAt)}`,
          lastLate: t.state === "stalled",
        };
      }),
    },
  ];
  const list = (
    <>
      <ListHeader title="Projects" count={`${rows.length} yours · ${threads.length} found`} add={false} tabs={tabs} />
      <PaneAlerts />
      {sp.hidden && /^t-[a-z0-9-]+$/.test(sp.hidden) ? <HiddenFlash id={sp.hidden} /> : null}
      <ProjectList groups={groups} foot="Found ones are never filed for you. They sit here until you keep one (it becomes a project) or say it isn't one thread." />
    </>
  );
  const reading = { groups: [{ key: "yours", ids: summaries.map((x) => x.slug) }, { key: "found", ids: threads.map((t) => tid(t.id)) }], param: "project", selected: pickThread ? tid(pickThread.id) : pick?.slug ?? null, auto: !sp.project, clear: ["item", "view", "undo", "was", "hidden"] };
  if (view === "board" && pickThread) {
    const base = `/projects?project=${encodeURIComponent(tid(pickThread.id))}`;
    const href = (id: string) => `${base}&item=${encodeURIComponent(id)}`;
    const item = sp.item ? pickThread.items.find((i) => i.id === sp.item) : undefined;
    const stands = readThreads().stands[pickThread.id] ?? null;
    return (
      <Shell days={await pastDays(user.id, "")} current="projects" reading={reading} list={list}
        detail={item ? (
          <ItemDetail item={item} items={items} meetings={meetings} user={user} now={now}
            crumb={{ page: "Projects", group: pickThread.name }} back={{ href: base, label: pickThread.name }}
            selfHref={href(item.id)} itemHref={href} />
        ) : <ThreadDetail t={pickThread} ctx={ctx} changes={getAiStore().contradictions()} stands={stands} href={href} pos={{ n: ids.indexOf(tid(pickThread.id)) + 1, of: ids.length }} />}
      />
    );
  }
  if (view === "board") {
    const item = pick && sp.item ? items.find((i) => i.id === sp.item) : undefined;
    const base = pick ? `/projects?project=${encodeURIComponent(pick.slug)}` : "/projects";
    const href = (id: string) => `${base}${base.includes("?") ? "&" : "?"}item=${encodeURIComponent(id)}`;
    const kindGroup = item ? (item.kind === "owe" ? "You owe" : item.kind === "waiting" ? "Waiting on" : "Decisions") : undefined;
    return (
      <Shell days={await pastDays(user.id, "")} current="projects" reading={reading} list={list}
        detail={item && pick ? (
          <ItemDetail item={item} items={items} meetings={meetings} user={user} now={now}
            crumb={{ page: "Projects", group: kindGroup }} back={{ href: base, label: pick.title }}
            selfHref={href(item.id)} itemHref={href} />
        ) : pick ? <ProjectDetail p={pick} ctx={ctx} href={href} status={statusOf(pick.slug)} />
          : <EmptyDetail text="No projects yet. Open Filing to make one from the topics your meetings share." />}
      />
    );
  }
  return (
    <Shell days={await pastDays(user.id, "")} current="projects" reading={{ ...reading, selected: null }} list={list} detail={
    <div className="rp-wrap">
      <Bar className="rp-bar--det"><CrumbLine crumb={{ page: "Projects", pageHref: "/projects", group: "Filing" }} /></Bar>
      <div className="rp-dbody rp-dbody--one"><div className="rp-main rp-legacy">
      <h1 className="db-title">Filing</h1>
      <p className="db-subtitle">
        Each promise, waiting-on and decision goes into the project it clearly belongs to, so one meeting can feed several projects. When it isn&apos;t clear, it waits under Needs a project. Move one and the app learns from it. Add <span className="db-mono">keywords:</span> to a project note to teach it words up front.
      </p>
      <Section title="Your projects" count={rows.length ? String(rows.length) : undefined} empty="No projects yet. Make one from a topic below, or with Project › New project on any item.">
        {rows.length ? (
          <ul className="st-list">
            {rows.map((p) => {
              const mine = open.filter((i) => i.project === p.slug);
              const a = mine.filter((i) => i.projectBy === "auto").length;
              return (
                <li key={p.slug}>
                  <Link className="st-list__row" href={`/notes/${encodeURIComponent(p.slug)}`}>
                    <span>{p.title}</span>
                    <span className="st-list__meta">{mine.length} open{a ? ` · ${a} filed automatically` : ""}{typeof p.props.status === "string" && p.props.status ? ` · ${p.props.status}` : ""}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
        {rows.length ? <p className="st-hint"><RefileButton /></p> : null}
      </Section>
      {topics.length ? (
        <Section title="Projects you could make" count={String(topics.length)}>
          <p className="st-hint">Topics from your meetings in the last {SUGGEST_DAYS} days that no project covers yet.</p>
          <SuggestedProjects topics={topics} />
        </Section>
      ) : null}
      <Section title="Needs a project" count={needs.length ? String(needs.length) : undefined} empty="Everything open is in a project, or you said it needs none.">
        <BulkMove rows={needs.map((i) => ({ id: i.id, text: i.text }))}>
          {needs.slice(0, 60).map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
        </BulkMove>
      </Section>
      {auto.length ? (
        <Section title="Filed automatically" count={String(auto.length)}>
          <p className="st-hint">Check these: open Project on one to keep it, move it, or take it out. Or Select several and move them at once.</p>
          <BulkMove rows={auto.map((i) => ({ id: i.id, text: i.text, meta: i.project ? `in ${rows.find((p) => p.slug === i.project)?.title ?? i.project}` : undefined }))}>
            {auto.slice(0, 40).map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} back={back} />)}
          </BulkMove>
        </Section>
      ) : null}
      </div></div>
    </div>} />
  );
}
