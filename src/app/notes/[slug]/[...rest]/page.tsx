import type { Metadata } from "next";
import { VaultNotePage, safeDecode } from "@/components/vault/VaultNotePage";
import { noteName } from "@/server/local/vault";

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string; rest: string[] }>;
const pathOf = async (params: Params) => { const p = await params; return [p.slug, ...p.rest].map(safeDecode).join("/"); };

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: noteName(await pathOf(params)) };
}

// A note in a folder of the workspace: /notes/Projects/Alpha.md (or without the .md).
export default async function NoteInFolder({ params }: { params: Params }) {
  return <VaultNotePage path={await pathOf(params)} />;
}
