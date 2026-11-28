import Link from "next/link";
import { dateLabel } from "@/lib/brief/time";
import { backlinks, linksToNote, linksToPerson, type WikiLink } from "@/lib/editor/links";
import type { PersonGroup } from "@/lib/people";
import type { Person } from "@/lib/directory/directory";
import { linkIsPerson } from "@/lib/directory/match";
import { linkSources, listPages } from "@/server/local/pages";

/** "Linked from": notes and daily notes that [[link]] to this person or note, with the lines. */
export function Backlinks({ person, note, day, people }: { person?: PersonGroup; note?: { slug: string; title: string }; day?: string; people?: Person[] }) {
  let list: ReturnType<typeof backlinks> = [];
  try {
    const sources = linkSources();
    const resolver = { notes: listPages().map((p) => ({ slug: p.slug, title: p.title })) };
    const match = (l: WikiLink) => (person ? linksToPerson(l, (name) => linkIsPerson(person, name, people), resolver) : note ? linksToNote(l, note) : day ? l.kind === "day" && l.target === day : false);
    list = backlinks(sources, match, note ? { type: "note", id: note.slug } : day ? { type: "day", id: day } : undefined);
  } catch {
    list = [];
  }
  if (day && !list.length) return null;
  return (
    <section className="db-section db-backlinks" aria-labelledby="db-backlinks-title">
      <div className="db-section__head">
        <h2 className="db-section__title" id="db-backlinks-title">Linked from</h2>
        {list.length ? <span className="db-section__count">{list.length}</span> : null}
      </div>
      {list.length ? (
        <ul className="db-backlinks__list">
          {list.map((b) => (
            <li key={`${b.type}:${b.id}`} className="db-backlinks__one">
              <Link className="db-backlinks__title" href={b.href}>{b.type === "day" ? dateLabel(b.id) : b.title}</Link>
              <span className="db-backlinks__kind">{b.type === "day" ? "Daily note" : "Note"}</span>
              {b.snippets.map((s, k) => <p key={k} className="db-backlinks__snip">{s}</p>)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="db-section__empty">No notes link here yet. Type [[ in a note to link {person ? "this person" : "this page"}.</p>
      )}
    </section>
  );
}
