import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Backlinks } from "@/components/Backlinks";
import { NoteEditor } from "@/components/editor/NoteEditor";
import { Shell } from "@/components/Shell";
import { me } from "@/server/local/app";
import { readPage } from "@/server/local/pages";
import { deleteNoteAction } from "../../notes-actions";
import { openCountFor, pastDays } from "../../_lib/days";
import { editorContext } from "../../_lib/editor";
import { linkChoices } from "../../_lib/structure";
import { ProjectSection } from "@/components/structure/ProjectSection";
import { readProperties } from "@/lib/structure/frontmatter";
import { PROJECT_TYPE, typeOf } from "@/lib/structure/note-types";
import { loadNoteTypes } from "@/server/structure/note-types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const page = readPage(decodeURIComponent((await params).slug));
  return { title: page?.title ?? "Note" };
}

// One free-form note: the editor, then what links here.
export default async function Note({ params }: { params: Promise<{ slug: string }> }) {
  const slug = decodeURIComponent((await params).slug);
  const user = await me();
  if (!user) redirect("/setup");
  const page = readPage(slug);
  if (!page) notFound();
  const types = loadNoteTypes().types;
  const isProject = typeOf(readProperties(page.markdown), types)?.id === PROJECT_TYPE;
  return (
    <Shell days={await pastDays(user.id, "")} current="notes" openCount={await openCountFor(user.id)}>
      <p className="db-crumb"><Link className="db-link" href="/notes">Notes</Link></p>
      <NoteEditor slug={page.slug} initial={page.markdown} hash={page.hash} {...await editorContext(user)} types={types} links={await linkChoices(user)} />
      {isProject ? <ProjectSection user={user} slug={page.slug} title={page.title} /> : null}
      <Backlinks note={{ slug: page.slug, title: page.title }} />
      <form className="db-notes-delete" action={deleteNoteAction}>
        <input type="hidden" name="slug" value={page.slug} />
        <span className="db-mono">notes/{page.slug}.md</span>
        <button className="db-act db-act--danger" type="submit">Delete note</button>
      </form>
    </Shell>
  );
}
