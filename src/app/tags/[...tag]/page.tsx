import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BriefItem, Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { tagHref } from "@/lib/structure/tag-core";
import { hasTag, normalizeTag, type TagNode } from "@/lib/structure/tags";
import { me } from "@/server/local/app";
import { openCountFor, pastDays } from "../../_lib/days";
import { loadAll, shortDate, toLine } from "../../_lib/lines";
import { loadStructure } from "../../_lib/structure";

export const dynamic = "force-dynamic";

const tagOf = async (params: Promise<{ tag: string[] }>) => normalizeTag((await params).tag.map(decodeURIComponent).join("/"));

export async function generateMetadata({ params }: { params: Promise<{ tag: string[] }> }): Promise<Metadata> {
  return { title: `#${(await tagOf(params)) ?? "tag"}` };
}

function find(nodes: TagNode[], tag: string): TagNode | null {
  for (const n of nodes) {
    if (n.tag === tag) return n;
    const c = find(n.children, tag);
    if (c) return c;
  }
  return null;
}

// One tag: the notes and items with it (or a tag nested under it).
export default async function TagPage({ params, searchParams }: { params: Promise<{ tag: string[] }>; searchParams: Promise<{ show?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const tag = await tagOf(params);
  if (!tag) redirect("/tags");
  const { show } = await searchParams;
  const s = await loadStructure(user);
  const { meetings } = await loadAll(user);
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const node = find(s.tree, tag);
  const notes = s.notes.filter((n) => hasTag(n.tags, tag)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const items = s.items.filter((i) => hasTag(i.tags, tag) && i.status !== "wrong");
  const open = items.filter((i) => i.status === "open" || i.status === "inbox");
  const closed = items.filter((i) => i.status === "done");
  const now = new Date();
  const parts = tag.split("/");
  const only = show === "notes" || show === "items" ? show : null;

  return (
    <Shell days={await pastDays(user.id, "")} current="tags" openCount={await openCountFor(user.id)}>
      <p className="db-crumb">
        <Link className="db-link" href="/tags">Tags</Link>
        {parts.slice(0, -1).map((_p, k) => <span key={k}> · <Link className="db-link" href={tagHref(parts.slice(0, k + 1).join("/"))}>#{parts.slice(0, k + 1).join("/")}</Link></span>)}
      </p>
      <h1 className="db-title">#{tag}</h1>
      <p className="db-subtitle st-filters" role="group" aria-label="Show">
        <Link className="st-pill" aria-current={!only ? "true" : undefined} href={tagHref(tag)}>All</Link>
        <Link className="st-pill" aria-current={only === "notes" ? "true" : undefined} href={`${tagHref(tag)}?show=notes`}>Notes {notes.length}</Link>
        <Link className="st-pill" aria-current={only === "items" ? "true" : undefined} href={`${tagHref(tag)}?show=items`}>Items {items.length}</Link>
        {node?.children.map((c) => <Link key={c.tag} className="st-tag" href={tagHref(c.tag)}>#{c.tag}</Link>)}
      </p>
      {only !== "items" ? (
        <Section title="Notes" count={notes.length ? String(notes.length) : undefined} empty={`No notes with #${tag}.`}>
          {notes.length ? (
            <ul className="st-list">
              {notes.map((n) => (
                <li key={n.slug}>
                  <Link className="st-list__row" href={`/notes/${encodeURIComponent(n.slug)}`}>
                    <span>{n.title}</span>
                    <span className="st-list__meta">{[n.typeName, shortDate(n.updatedAt, user.timeZone)].filter(Boolean).join(" · ")}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}
      {only !== "notes" ? (
        <>
          <Section title="Open items" count={open.length ? String(open.length) : undefined} empty={`Nothing open with #${tag}.`}>
            {open.map((i) => <BriefItem key={i.id} line={toLine(i, byId, user, now)} />)}
          </Section>
          {closed.length ? (
            <Section title="Done" count={String(closed.length)}>
              <ul className="st-list">
                {closed.slice(0, 50).map((i) => <li key={i.id}><Link className="st-list__row" href={`/item/${encodeURIComponent(i.id)}`}><span className="db-mark db-mark--done" aria-hidden="true" /><span>{i.text}</span></Link></li>)}
              </ul>
            </Section>
          ) : null}
        </>
      ) : null}
    </Shell>
  );
}
