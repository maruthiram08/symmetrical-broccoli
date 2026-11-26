import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { NoteTypesEditor } from "@/components/structure/NoteTypesEditor";
import { me } from "@/server/local/app";
import { loadNoteTypes } from "@/server/structure/note-types";
import { openCountFor, pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Note types" };

// Note types for this workspace: default properties and a template for each.
export default async function NoteTypes() {
  const user = await me();
  if (!user) redirect("/setup");
  const { types, error } = loadNoteTypes();
  return (
    <Shell days={await pastDays(user.id, "")} current="notes" openCount={await openCountFor(user.id)}>
      <p className="db-crumb"><Link className="db-link" href="/notes">Notes</Link></p>
      <h1 className="db-title">Note types</h1>
      <p className="db-subtitle">
        A note’s type is its <span className="db-mono">type:</span> property. New notes of a type start with its properties and template: from <span className="db-mono">/new</span> in a note, or “New … note” in ⌘K. A note of type Project gets a board of its items.
      </p>
      <NoteTypesEditor initial={types} error={error} />
    </Shell>
  );
}
