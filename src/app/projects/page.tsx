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
import { openCountFor, pastDays } from "../_lib/days";
import { loadAll, toLine } from "../_lib/lines";
import { ProjectBoardView } from "./ProjectBoardView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Projects" };

const SUGGEST_DAYS = 45;
const newestFirst = (a: Item, b: Item) => b.createdAt.localeCompare(a.createdAt);

// Two views. By project (default): every project with its open items, decisions and the meetings
// that fed it. Filing: your projects, what was filed into them on its own, what still needs a project, and projects worth
// making from the topics your meetings share. Filing runs on load, so a project you just made in a
// note, or new keywords, take effect here.
export default async function Projects({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view = (await searchParams).view === "filing" ? "filing" : "board";
  const user = await me();
  if (!user) redirect("/setup");
  await autoFileProjects(getFileStore(), user.id).catch(() => undefined);
  const { items, meetings } = await loadAll(user);
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
    <p className="db-subtitle pf-tabs" role="tablist">
      <Link role="tab" aria-selected={view === "board"} className={view === "board" ? "pf-tab pf-tab--on" : "pf-tab"} href="/projects">By project</Link>
      <Link role="tab" aria-selected={view === "filing"} className={view === "filing" ? "pf-tab pf-tab--on" : "pf-tab"} href="/projects?view=filing">Filing{needs.length ? ` · ${needs.length} need a project` : ""}</Link>
    </p>
  );
  if (view === "board") {
    return (
      <Shell days={await pastDays(user.id, "")} current="projects" openCount={await openCountFor(user.id)}>
        <h1 className="db-title">Projects</h1>
        {tabs}
        <ProjectBoardView projects={rows.map((r) => ({ slug: r.slug, title: r.title, status: typeof r.props.status === "string" ? r.props.status : null }))} items={live} meetings={meetings} user={user} now={now} needs={needs.length} topics={topics.length} />
      </Shell>
    );
  }
  return (
    <Shell days={await pastDays(user.id, "")} current="projects" openCount={await openCountFor(user.id)}>
      <h1 className="db-title">Projects</h1>
      {tabs}
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
    </Shell>
  );
}
