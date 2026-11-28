import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { normalizeTag } from "@/lib/structure/tags";
import { TagsPanes } from "../_tags";
export const dynamic = "force-dynamic";

const tagOf = async (params: Promise<{ tag: string[] }>) => normalizeTag((await params).tag.map(decodeURIComponent).join("/"));

export async function generateMetadata({ params }: { params: Promise<{ tag: string[] }> }): Promise<Metadata> {
  return { title: `#${(await tagOf(params)) ?? "tag"}` };
}

// One tag: its numbers, what's open, and what was decided under it.
export default async function TagPage({ params }: { params: Promise<{ tag: string[] }> }) {
  const tag = await tagOf(params);
  if (!tag) redirect("/tags");
  return <TagsPanes tag={tag} />;
}
