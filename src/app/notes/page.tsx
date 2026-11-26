import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { VaultNotePage } from "@/components/vault/VaultNotePage";
import { me } from "@/server/local/app";
import { listPages, pagesDir } from "@/server/local/pages";
import { notesDir } from "@/server/local/paths";
import { newNoteFormAction } from "../notes-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Notes" };

const when = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });

// Your free-form pages: plain .md files in ~/Daily Brief/notes, newest first.
export default async function Notes() {
  const user = await me();
  if (!user) redirect("/setup");
  const pages = listPages();
  return (
    <VaultNotePage path={null}>
      <h1 className="db-title">Notes</h1>
      <p className="db-subtitle">
        Pages of your own, each a Markdown file in <span className="db-mono">{pagesDir(notesDir()).replace(/^\/Users\/[^/]+/, "~")}</span>. Every other .md file in the folder is under Files. <Link className="db-link" href="/note-types">Note types</Link> · <Link className="db-link" href="/tags">Tags</Link>
      </p>
      <form className="db-notes-new" action={newNoteFormAction}>
        <input className="db-input" name="title" placeholder="New note title" aria-label="New note title" maxLength={120} autoComplete="off" />
        <button className="db-act db-act--primary" type="submit">New note</button>
      </form>
      {pages.length ? (
        <ul className="db-notes-list">
          {pages.map((p) => (
            <li key={p.slug}>
              <Link className="db-notes-list__row" href={`/notes/${encodeURIComponent(p.slug)}`}>
                <span className="db-notes-list__title">{p.title}</span>
                <span className="db-notes-list__when">{when(p.updatedAt, user.timeZone)}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="db-section__empty">No notes yet. Give the first one a title above.</p>
      )}
    </VaultNotePage>
  );
}
