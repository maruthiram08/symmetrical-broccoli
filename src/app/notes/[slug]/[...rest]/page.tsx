import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { safeDecode } from "@/components/vault/VaultNotePage";
import { notesDir } from "@/server/local/paths";
import { noteName, resolveNotePath } from "@/server/local/vault";
import { NotesPanes, noteMode } from "../../_notes";

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string; rest: string[] }>;
const pathOf = async (params: Params) => { const p = await params; return [p.slug, ...p.rest].map(safeDecode).join("/"); };

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: noteName(await pathOf(params)) };
}

// A note in a folder of the workspace: /notes/Projects/Alpha.md (or without the .md).
export default async function NoteInFolder({ params, searchParams }: { params: Params; searchParams: Promise<{ mode?: string }> }) {
  const path = resolveNotePath(notesDir(), await pathOf(params));
  if (!path) notFound();
  return <NotesPanes path={path} mode={noteMode((await searchParams).mode)} />;
}
