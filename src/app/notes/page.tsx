import type { Metadata } from "next";
import { VaultNotePage } from "@/components/vault/VaultNotePage";
import { NotesPanes, noteMode } from "./_notes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Notes" };

// Notes: grouped in the list, the picked one on the right. ?view=files is the workbench (the
// folder tree, tabs and split panes), with ?open=<path> in front.
export default async function Notes({ searchParams }: { searchParams: Promise<{ view?: string; open?: string; mode?: string }> }) {
  const q = await searchParams;
  if (q.view === "files") return <VaultNotePage path={q.open ?? null} />;
  return <NotesPanes path={null} mode={noteMode(q.mode)} />;
}
