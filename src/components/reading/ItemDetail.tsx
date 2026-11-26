// The detail pane for one item: header bar, the reading column (kind, title, actions, quote,
// Get it done, siblings, history) and the rail (details, person, keys). Also the /item/[id] page.
import Link from "next/link";
import type { ReactNode } from "react";
import { formatTime, localDate } from "@/lib/brief/time";
import { isManual } from "@/lib/capture/items";
import { initials, personSlug } from "@/lib/people";
import { badgeOf, dayName, markOf, shortDay, type Ctx } from "@/lib/reading/model";
import { projectLabel } from "@/lib/structure/views";
import type { Item, Meeting, User } from "@/lib/types";
import { relatedItems, timeline, type TimelineEvent } from "@/lib/wow/timeline";
import { startedLabels } from "@/server/handoff";
import { projectRows } from "@/server/structure/notes";
import { getIntegrations } from "@/server/integrations/config";
import { enabledProviders, PROVIDERS } from "@/server/integrations/tickets";
import { HandoffPanel } from "../StartThis";
import { BlockCta, GetItDone, ItemMenu, SnoozeCta } from "./ItemActions";
import { BackToList, DetailNav, DoneButton } from "./Pane";

export interface Crumb { page: string; pageHref?: string; group?: string }

function Mark({ m }: { m: string }) {
  return <span className={`rp-m rp-m--${m}`} aria-hidden="true" />;
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link className="rp-back" href={href} scroll={false}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
      {label}
    </Link>
  );
}

export function Bar({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rp-bar ${className}`}>{children}</div>;
}

export function CrumbLine({ crumb, back }: { crumb: Crumb; back?: { href: string; label: string } | null }) {
  return (
    <div className="rp-crumb">
      <BackToList />
      {back ? <BackLink href={back.href} label={back.label} /> : null}
      {crumb.pageHref ? <Link href={crumb.pageHref} className="rp-crumb__page">{crumb.page}</Link> : <span className="rp-crumb__page">{crumb.page}</span>}
      {crumb.group ? <><span aria-hidden="true">›</span><b>{crumb.group}</b></> : null}
    </div>
  );
}

export async function ItemDetail({ item, items, meetings, user, now, crumb, back, inPane, selfHref, itemHref, full, extra }: {
  item: Item; items: Item[]; meetings: Meeting[]; user: User; now: Date;
  crumb: Crumb; back?: { href: string; label: string } | null;
  /** In the three panes: ↑ ↓ and N of M. */
  inPane?: boolean;
  /** Where an action lands when no list is around (the page itself). */
  selfHref: string;
  /** Link for another item (a sibling): stays in this page's list. */
  itemHref: (id: string) => string;
  full?: boolean;
  /** The full page's extras: tags and project editing, team sharing. */
  extra?: ReactNode;
}) {
  const tz = user.timeZone;
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const ctx: Ctx = { meetings: byId, timeZone: tz, now };
  const m = byId.get(item.meetingId);
  const wispr = m?.link?.startsWith("https://") ? m.link : null;
  const mark = markOf(item, now);
  const late = mark === "late";
  const open = item.status === "open";
  const done = item.status === "done";
  const actionable = item.kind !== "decision";
  const manual = isManual(item);
  const lateDays = late && item.dueAt ? Math.floor((now.getTime() - Date.parse(item.dueAt)) / 86_400_000) : 0;
  const status = item.kind === "decision" ? (open ? "Decided" : "Removed")
    : done ? "Kept" : item.status === "wrong" ? "Not a promise" : item.status === "inbox" ? "In your Inbox"
    : late ? (lateDays >= 1 ? `${lateDays} day${lateDays === 1 ? "" : "s"} late` : badgeOf(item, ctx)) : item.snoozedUntil && item.snoozedUntil > localDate(now, tz) ? "Snoozed" : "Open";
  const kindLabel = item.kind === "decision" ? "Decision" : item.kind === "waiting" ? `Waiting on ${item.person ?? "someone"}` : item.person ? `You owe ${item.person}` : "You owe yourself";
  const heard = m ? `${shortDay(m.startedAt, tz)}, ${formatTime(m.startedAt, tz)}` : `${shortDay(item.createdAt, tz)}, ${formatTime(item.createdAt, tz)}`;
  const saidBy = item.kind === "decision" ? "Said in the meeting" : item.kind === "waiting" ? `${item.person ?? "They"} said` : "You said";
  const avatar = item.kind === "waiting" && item.person ? initials(item.person).slice(0, 1) : initials(user.name).slice(0, 1) || "Y";

  const sibs = items.filter((i) => !manual && i.meetingId === item.meetingId && i.id !== item.id && i.status !== "wrong" && i.status !== "inbox").slice(0, 4);
  const self = [user.name, ...user.aliases];
  const events = timeline(item, items, meetings, now, self);
  const related = full ? relatedItems(item, items, meetings, self) : [];

  // The person card: how many they have open and kept with you.
  const slug = item.person ? personSlug(item.person) : "";
  const theirs = slug ? items.filter((i) => i.kind !== "decision" && i.status !== "wrong" && i.person && personSlug(i.person) === slug) : [];
  const pOpen = theirs.filter((i) => i.status === "open").length;
  const pKept = theirs.filter((i) => i.status === "done").length;

  const providers = actionable && open ? enabledProviders(getIntegrations()) : [];
  const started = actionable ? (await startedLabels().catch(() => new Map<string, string>())).get(item.id) ?? null : null;
  const ticket = item.ticket ? { key: item.ticket.key, url: item.ticket.url, label: PROVIDERS[item.ticket.provider]?.label ?? "" } : null;
  const due = item.dueAt ? `${shortDay(item.dueAt, tz)}, ${formatTime(item.dueAt, tz)}` : "No date said";
  let projectTitle = item.project ? projectLabel(item.project) : "";
  try { projectTitle = projectRows().find((r) => r.slug === item.project)?.title ?? projectTitle; } catch { /* no notes folder */ }
  const comesBack = open && item.snoozedUntil ? dayName(item.snoozedUntil) : "—";

  return (
    <div className="rp-wrap">
      <Bar className="rp-bar--det">
        <CrumbLine crumb={crumb} back={back} />
        <div className="rp-acts">
          {inPane ? <DetailNav id={item.id} /> : null}
          <ItemMenu id={item.id} project={item.project ?? null} quote={item.quote} starred={!!item.starred} actionable={actionable && open} manual={manual} back={selfHref} fullHref={full ? undefined : `/item/${encodeURIComponent(item.id)}`} />
        </div>
      </Bar>
      <div className="rp-dbody">
        <article className="rp-main">
          <div>
            <div className="rp-kind">
              <Mark m={mark} />{kindLabel}
              <span className={`rp-st${late ? " rp-st--late" : ""}`}>{status}</span>
              {item.starred ? <span className="rp-st">Starred</span> : null}
            </div>
            <h1 className="rp-title">{item.text}</h1>
            {item.status === "open" || item.status === "done" ? (
              <div className="rp-cta">
                {actionable ? <DoneButton id={item.id} done={done} back={selfHref} /> : null}
                {actionable && open ? <SnoozeCta id={item.id} snoozedUntil={item.snoozedUntil ?? null} /> : null}
                {item.kind === "owe" && open ? <BlockCta id={item.id} /> : null}
                {!actionable ? <span className="rp-cta__note">Decisions stay on record. Use ⋯ if this wasn&apos;t one.</span> : null}
              </div>
            ) : null}
          </div>

          {item.quote || item.note ? (
            <blockquote className="rp-quote">
              <p>{manual ? item.note : <>&ldquo;{item.quote}&rdquo;</>}</p>
              <footer>
                <span className="rp-quote__av" aria-hidden="true">{manual ? initials(user.name).slice(0, 1) : avatar}</span>
                <span>{manual ? "Your note" : saidBy} · {heard}</span>
                {wispr ? <a href={wispr} target="_blank" rel="noopener noreferrer">Open transcript</a> : m ? <Link href={`/meeting/${encodeURIComponent(m.id)}`}>Open meeting</Link> : null}
              </footer>
            </blockquote>
          ) : null}

          {actionable && open ? (
            <section className="rp-sec">
              <h2>Get it done</h2>
              <GetItDone id={item.id} kind={item.kind as "owe" | "waiting"} person={item.person} ticket={ticket} providers={providers} />
              <HandoffPanel itemId={item.id} kind={item.kind as "owe" | "waiting"} person={item.person} started={started} />
            </section>
          ) : null}

          {m && !manual ? (
            <section className="rp-sec">
              <h2>Also from {m.title || "this meeting"}</h2>
              <div className="rp-sib">
                {sibs.length ? sibs.map((x) => (
                  <Link key={x.id} href={itemHref(x.id)} scroll={false}>
                    <Mark m={markOf(x, now)} />
                    <span className={`rp-sib__t${x.status === "done" ? " rp-sib__t--done" : ""}`}>{x.text}</span>
                    <span className="rp-sib__b">{badgeOf(x, ctx, { showBack: true })}</span>
                  </Link>
                )) : <div className="rp-sib__none"><span /><span>Nothing else came out of this meeting</span><span /></div>}
              </div>
            </section>
          ) : null}

          <section className="rp-sec">
            <h2>History</h2>
            <ol className="rp-tl" aria-label="What happened to this item">
              {events.map((e, k) => <HistoryEvent key={k} e={e} item={item} tz={tz} itemHref={itemHref} />)}
            </ol>
          </section>

          {full && related.length ? (
            <section className="rp-sec">
              <h2>Related earlier</h2>
              <div className="rp-sib">
                {related.map((r) => (
                  <Link key={r.item.id} href={`/item/${encodeURIComponent(r.item.id)}`}>
                    <Mark m={markOf(r.item, now)} />
                    <span className="rp-sib__t">{r.item.text}</span>
                    <span className="rp-sib__b">{r.meeting ? shortDay(r.meeting.startedAt, tz) : ""}{r.why ? ` · ${r.why}` : ""}</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
          {extra ? <div className="rp-extra">{extra}</div> : null}
        </article>

        <aside className="rp-rail" aria-label="Details">
          <section className="rp-sec">
            <h2>Details</h2>
            <dl className="rp-kv">
              <dt>Status</dt><dd className={late ? "rp-late" : undefined}>{status}</dd>
              <dt>Person</dt><dd>{slug ? <Link href={`/people/${encodeURIComponent(slug)}`}>{item.person}</Link> : item.person ?? "Just you"}</dd>
              <dt>Meeting</dt><dd>{m ? <Link href={`/meeting/${encodeURIComponent(m.id)}`}>{m.title || "Meeting"}</Link> : manual ? "Added by you" : "—"}</dd>
              <dt>Heard</dt><dd>{heard}</dd>
              {actionable ? <><dt>Due</dt><dd className={late ? "rp-late" : undefined}>{due}</dd></> : null}
              {actionable ? <><dt>Comes back</dt><dd>{comesBack}</dd></> : null}
              <dt>Project</dt>
              <dd>
                {item.project ? <Link href={`/projects?project=${encodeURIComponent(item.project)}`}>{projectTitle}</Link> : "None yet"}
                {item.project && item.projectBy === "auto" ? <span className="rp-dd__why">Filed automatically, {item.projectWhy ?? "from its meeting"}</span> : null}
                {actionable && open ? <span className="rp-dd__hint">Move it with <span className="rp-kbd">P</span></span> : null}
              </dd>
              {ticket ? <><dt>Ticket</dt><dd><a href={ticket.url} target="_blank" rel="noopener noreferrer">{ticket.key}</a></dd></> : null}
            </dl>
          </section>
          {slug ? (
            <div className="rp-pcard">
              <div className="rp-pcard__top">
                <span className="rp-pcard__av" aria-hidden="true">{initials(item.person!).slice(0, 2)}</span>
                <div><div className="rp-pcard__nm">{item.person}</div><div className="rp-pcard__ln">{pOpen} open · {pKept} kept</div></div>
              </div>
              <div className="rp-meter" role="img" aria-label={`${pKept} kept, ${pOpen} open`}>
                <span className="rp-meter__k" style={{ flex: pKept || 0.001 }} />
                <span className="rp-meter__o" style={{ flex: pOpen || 0.001 }} />
              </div>
              <Link className="rp-pcard__go" href={`/people/${encodeURIComponent(slug)}`}>Open {item.person!.split(/\s+/)[0]}&apos;s page</Link>
            </div>
          ) : null}
          <KeysCard />
        </aside>
      </div>
    </div>
  );
}

export function KeysCard() {
  return (
    <section className="rp-sec">
      <h2>Keys</h2>
      <div className="rp-keys">
        <span>Next / previous</span><span><span className="rp-kbd">J</span> <span className="rp-kbd">K</span></span>
        <span>Mark done</span><span className="rp-kbd">E</span>
        <span>Snooze</span><span className="rp-kbd">S</span>
        <span>Block time</span><span className="rp-kbd">B</span>
        <span>Add an item</span><span className="rp-kbd">C</span>
        <span>More</span><span className="rp-kbd">.</span>
      </div>
    </section>
  );
}

function HistoryEvent({ e, item, tz, itemHref }: { e: TimelineEvent; item: Item; tz: string; itemHref: (id: string) => string }) {
  const when = (iso: string) => `${shortDay(iso, tz)}, ${formatTime(iso, tz)}`;
  const where = (m: Meeting | null) => (m ? ` in ${m.title || "a meeting"}` : "");
  switch (e.kind) {
    case "made":
      return <li><b>{isManual(item) ? "Added" : item.kind === "decision" ? "Decided" : "Heard"}</b> {when(e.at)}{where(e.meeting)}</li>;
    case "mentioned":
      return <li><b>Came up again</b> {when(e.at)}{where(e.meeting)}: <Link href={itemHref(e.itemId)} scroll={false}>&ldquo;{e.quote}&rdquo;</Link></li>;
    case "due":
      return <li className={e.passed && item.status === "open" ? "rp-tl--late" : undefined}><b>{e.passed ? (item.status === "open" ? "Was due" : "Due") : "Due"}</b> {when(e.at)}{e.passed ? "" : ", coming up"}</li>;
    case "closed":
      return <li className="rp-tl--end"><b>Kept</b> {when(e.at)}{where(e.meeting)}{e.quote ? <>: &ldquo;{e.quote}&rdquo;</> : null}</li>;
    case "marked":
      return <li className="rp-tl--end"><b>{e.reason ?? (e.status === "done" ? "You marked it done" : "You marked it not a promise")}</b> {when(e.at)}</li>;
    case "open":
      return <li className="rp-tl--now"><b>Still open</b>{item.snoozedUntil && item.status === "open" ? `, snoozed until ${dayName(item.snoozedUntil)}` : ", nothing has closed it yet"}</li>;
  }
}

/** The detail pane with nothing to show. */
export function EmptyDetail({ text }: { text: string }) {
  return <div className="rp-wrap"><div className="rp-bar"><BackToList /></div><p className="rp-quiet rp-quiet--pad">{text}</p></div>;
}
