import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NotesPanes, noteMode } from "../_notes";
import { safeDecode } from "@/components/vault/VaultNotePage";
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

// One note: a page in notes/ by its slug ("/notes/q4-plan"), or any .md file in the workspace
// folder by its path ("/notes/Projects%2FAlpha.md"), in the reading pane.
export default async function Note({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ mode?: string }> }) {
  const slug = safeDecode((await params).slug);
  const path = resolveNotePath(notesDir(), slug);
  if (!path) notFound();
  return <NotesPanes path={path} mode={noteMode((await searchParams).mode)} />;
}
