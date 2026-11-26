import Link from "next/link";
import { Section } from "@/components/BriefList";
import { linksToNote, parseWikiLink } from "@/lib/editor/links";
import type { User } from "@/lib/types";
import { itemCard, loadStructure } from "@/app/_lib/structure";
import { ProjectBoard } from "./ProjectBoard";

/** On a Project note: its items as a Kanban, and the notes that belong to it. */
export async function ProjectSection({ user, slug, title }: { user: User; slug: string; title: string }) {
  const s = await loadStructure(user);
  const now = new Date();
  const mine = s.items.filter((i) => i.project === slug && i.status !== "wrong");
  const open = (k: "owe" | "waiting") => mine.filter((i) => i.status !== "done" && i.kind === k);
  const columns = [
    { key: "owe", label: "You owe", cards: open("owe").map((i) => itemCard(i, user, now)) },
    { key: "waiting", label: "Waiting on", cards: open("waiting").map((i) => itemCard(i, user, now)) },
    { key: "done", label: "Done", cards: mine.filter((i) => i.status === "done").sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")).slice(0, 30).map((i) => itemCard(i, user, now)) },
  ];
  // Notes in the project: a property that links here (project: "[[note:slug]]").
  const self = { slug, title };
  const linked = s.notes.filter((n) => n.slug !== slug && Object.values(n.props).some((v) => (Array.isArray(v) ? v : [v]).some((x) => {
    if (typeof x !== "string") return false;
    const l = parseWikiLink(x.trim());
    return !!l && linksToNote(l, self);
  })));
  const decisions = mine.filter((i) => i.kind === "decision" && i.status === "open");
  return (
    <>
      <Section title="Project items" count={mine.length ? String(mine.filter((i) => i.status === "open").length) + " open" : undefined}>
        <ProjectBoard columns={columns} slug={slug} />
      </Section>
      {decisions.length ? (
        <Section title="Decisions" count={String(decisions.length)}>
          <ul className="st-list">{decisions.map((d) => <li key={d.id}><Link className="st-list__row" href={`/item/${encodeURIComponent(d.id)}`}><span className="db-mark db-mark--decision" aria-hidden="true" /><span>{d.text}</span></Link></li>)}</ul>
        </Section>
      ) : null}
      <Section title="Notes in this project" count={linked.length ? String(linked.length) : undefined} empty={`No notes yet. Give a note the property project: [[note:${slug}]] (a Meeting note has one).`}>
        {linked.length ? (
          <ul className="st-list">
            {linked.map((n) => (
              <li key={n.slug}><Link className="st-list__row" href={`/notes/${encodeURIComponent(n.slug)}`}><span>{n.title}</span><span className="st-list__meta">{n.typeName ?? "Note"}</span></Link></li>
            ))}
          </ul>
        ) : null}
      </Section>
    </>
  );
}
