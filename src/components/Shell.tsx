import Link from "next/link";
import { cookies } from "next/headers";
import { cache, type ReactNode } from "react";
import { localDate } from "@/lib/brief/time";
import { isSnoozed } from "@/lib/capture/items";
import { MODE_COOKIE, parseMode } from "@/lib/theme/mode";
import { isHosted } from "@/server/mode";
import { getStore, me } from "@/server/local/app";
import { projectRows } from "@/server/structure/notes";
import { SearchIcon } from "./SearchIcon";
import { Progress } from "./Progress";
import { SideNav } from "./SideNav";
import { HostedLinks } from "./HostedLinks";
import { InboxLink, WorkspaceSwitch } from "./WorkspaceNav";
import { ModeToggle } from "./reading/ModeToggle";
import { ReadingProvider, type ReadingSetup } from "./reading/Pane";

const ICONS = {
  today: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>,
  open: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 9h8M8 13h8M8 17h5" /></svg>,
  people: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2" /></svg>,
  projects: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" /></svg>,
};

/** The sidebar's counts: late today, everything open, and projects. Once per request. */
const navCounts = cache(async () => {
  const user = await me();
  if (!user) return { late: 0, open: 0, projects: 0, views: [] as Array<{ id: string; name: string }> };
  const store = getStore();
  const now = new Date();
  const today = localDate(now, user.timeZone);
  const open = (await store.listItems(user.id, { status: "open" })).filter((i) => i.kind !== "decision");
  const late = open.filter((i) => !isSnoozed(i, today) && i.dueAt && Date.parse(i.dueAt) < now.getTime()).length;
  let projects = 0;
  try { projects = projectRows().length; } catch { projects = 0; }
  const views = await store.listViews(user.id).catch(() => []);
  return { late, open: open.length, projects, views: views.map((v) => ({ id: v.id, name: v.name })) };
});

const LABELS: Record<string, string> = {
  today: "Today", wrap: "Wrap", week: "This week", open: "All open", item: "Item", people: "People", projects: "Projects",
  series: "Recurring", routines: "Routines", review: "Review", crosscheck: "Cross-check", ask: "Ask", notes: "Notes",
  meeting: "Meeting", canvas: "Canvas", tags: "Tags", views: "Views", inbox: "Inbox", search: "Search", settings: "Settings", "note-types": "Note types",
};

function Nav({ href, on, children, sub, tip }: { href: string; on: boolean; children: ReactNode; sub?: boolean; tip?: string }) {
  return <Link className={`db-nav rp-ni${sub ? " rp-ni--sub" : ""}`} href={href} aria-current={on ? "page" : undefined} title={tip}>{children}</Link>;
}

async function Sidebar({ current, footer, query }: { current: string; footer?: ReactNode; query?: string }) {
  const c = await navCounts();
  const mode = parseMode((await cookies()).get(MODE_COOKIE)?.value);
  const is = (...k: string[]) => k.includes(current);
  return (
    <SideNav brand={<span className="rp-brand"><i aria-hidden="true" />Daily brief</span>} foot={<ModeToggle initial={mode} />}>
      <WorkspaceSwitch />
      <form className="db-search rp-search" action="/search" role="search">
        <SearchIcon />
        <input id="db-search" className="db-search__input" type="search" name="q" defaultValue={query} placeholder="Search" aria-label="Search everything" autoComplete="off" />
        <span className="rp-kbd" aria-hidden="true">⌘K</span>
      </form>
      <Nav tip="Today" href="/" on={is("today", "wrap", "week")}>{ICONS.today}<span>Today</span>{c.late ? <span className="rp-ni__c rp-ni__c--late">{c.late} late</span> : null}</Nav>
      <Nav tip="All open" href="/open" on={is("open", "item")}>{ICONS.open}<span>All open</span>{c.open ? <span className="rp-ni__c">{c.open}</span> : null}</Nav>
      <Nav tip="People" href="/people" on={is("people")}>{ICONS.people}<span>People</span></Nav>
      <Nav tip="Projects" href="/projects" on={is("projects")}>{ICONS.projects}<span>Projects</span>{c.projects ? <span className="rp-ni__c">{c.projects}</span> : null}</Nav>
      <InboxLink current={current} />
      <div className="rp-sh">Library</div>
      <Nav href="/day" on={is("day") || /^\d{4}-\d{2}-\d{2}$/.test(current)}><span>Daily briefs</span></Nav>
      <Nav href="/series" on={is("series")}><span>Recurring</span></Nav>
      <Nav href="/routines" on={is("routines")}><span>Routines</span></Nav>
      <Nav href="/review" on={is("review", "names")}><span>Review</span></Nav>
      {isHosted() ? null : <Nav href="/crosscheck" on={is("crosscheck")} sub><span>Cross-check</span></Nav>}
      <Nav href="/ask" on={is("ask")}><span>Ask</span></Nav>
      <Nav href="/notes" on={is("notes")}><span>Notes</span></Nav>
      <Nav href="/canvas" on={is("canvas")}><span>Canvas</span></Nav>
      <Nav href="/tags" on={is("tags")}><span>Tags</span></Nav>
      <Nav href="/views" on={is("views")}><span>Views</span></Nav>
      {c.views.map((v) => <Nav key={v.id} href={`/views/${encodeURIComponent(v.id)}`} on={current === `view:${v.id}`} sub><span>{v.name}</span></Nav>)}
      <div className="db-side__foot rp-foot">
        <Nav href="/setup" on={is("settings")}><span>Settings</span></Nav>
        <HostedLinks />
        {footer}
      </div>
    </SideNav>
  );
}

/**
 * The app's frame: the sidebar, then either the reading pane (a list and the selected thing's
 * detail, each scrolling on its own) or one wide pane for pages that aren't lists.
 * `days` are past daily notes, newest first; Daily briefs lists them now, so the sidebar no longer does.
 */
export function Shell({ current, children, footer, query, wide, list, detail, reading, pane, title, show, raw }: {
  /** Kept for callers. */
  days?: Array<{ date: string; label: string }>; current: string; children?: ReactNode; footer?: ReactNode;
  /** Kept for callers; the sidebar counts for itself now. */
  openCount?: number; query?: string; wide?: boolean;
  /** The reading pane: the list (400px) and the detail (the rest). */
  list?: ReactNode; detail?: ReactNode; reading?: ReadingSetup;
  /** One full-height pane with its own header bar (the item page). */
  pane?: ReactNode;
  /** The wide pane's header bar. Defaults to the section's name. */
  title?: string;
  /** Without `reading`: which pane a phone shows, the list or the detail. */
  show?: "list" | "detail";
  /** Panes a client component lays out itself (Ask): placed straight after the sidebar. */
  raw?: ReactNode;
}) {
  const side = <Sidebar current={current} footer={footer} query={query} />;
  if (raw !== undefined) return <div className="db-shell rp-shell" data-panes="3">{side}{raw}</div>;
  if (list !== undefined) {
    const panes = (
      <>
        <section className="rp-list" aria-label="List"><div className="rp-wrap">{list}</div></section>
        <section className="rp-det" aria-label="Detail">{detail}</section>
      </>
    );
    return (
      <div className="db-shell rp-shell" data-panes="3">
        {side}
        {reading ? <ReadingProvider {...reading}>{panes}</ReadingProvider> : <div className="rp-panes" data-show={show ?? "list"}>{panes}</div>}
      </div>
    );
  }
  if (pane !== undefined) {
    return (
      <div className="db-shell rp-shell" data-panes="1">
        {side}
        <main className="rp-det rp-det--page">{pane}</main>
      </div>
    );
  }
  const label = title ?? LABELS[current] ?? (/^\d{4}-\d{2}-\d{2}$/.test(current) ? "Daily note" : current.startsWith("view:") ? "View" : "");
  return (
    <div className="db-shell rp-shell" data-panes="1">
      {side}
      <main className="db-main rp-wide">
        <div className="rp-bar"><span className="rp-crumb"><b>{label}</b></span></div>
        <div className="rp-wide__scroll">
          <div className={wide ? "db-main__col db-main__col--wide" : "db-main__col"}><Progress />{children}</div>
        </div>
      </main>
    </div>
  );
}

/** Banners and the reading progress, for the top of a list pane. */
export function PaneAlerts() {
  return <div className="rp-alerts"><Progress /></div>;
}
