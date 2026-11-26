import type { Metadata } from "next";
import { ExportMenu } from "@/components/ExportMenu";
import { LocalGraph } from "@/components/graph/LocalGraph";
import { FrontOnly } from "@/components/vault/FrontOnly";
import { VaultNotePage, safeDecode } from "@/components/vault/VaultNotePage";
import { me } from "@/server/local/app";
import { notesDir } from "@/server/local/paths";
import { noteName, resolveNotePath } from "@/server/local/vault";
import { readPage } from "@/server/local/pages";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const slug = safeDecode((await params).slug);
  const page = readPage(slug);
  if (page) return { title: page.title };
  const path = resolveNotePath(notesDir(), slug);
  return { title: path ? noteName(path) : "Note" };
}

// One note, in the notes workbench: a page in notes/ by its slug ("/notes/q4-plan"), or any .md
// file in the workspace folder by its path ("/notes/Projects%2FAlpha.md", "/notes/Inbox.md").
// A page in notes/ also gets its export menu and local graph, while it is the note in front.
export default async function Note({ params }: { params: Promise<{ slug: string }> }) {
  const slug = safeDecode((await params).slug);
  const page = readPage(slug);
  const user = page ? await me() : null;
  const after = page && user ? (
    <FrontOnly path={`notes/${page.slug}.md`}>
      <div className="db-crumb ex-crumb"><ExportMenu type="note" id={page.slug} /></div>
      <LocalGraph user={user} center={`note:${page.slug}`} />
    </FrontOnly>
  ) : null;
  return <VaultNotePage path={slug} after={after} />;
}
