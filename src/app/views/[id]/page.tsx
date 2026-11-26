import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ViewEditor } from "@/components/structure/ViewEditor";
import { propTypeFor, typeOf } from "@/lib/structure/note-types";
import { getStore, me } from "@/server/local/app";
import { loadNoteTypes } from "@/server/structure/note-types";
import { openCountFor, pastDays } from "../../_lib/days";
import { loadStructure } from "../../_lib/structure";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const user = await me();
  const id = decodeURIComponent((await params).id);
  const v = user ? (await getStore().listViews(user.id)).find((x) => x.id === id) : undefined;
  return { title: v?.name ?? "View" };
}

export default async function ViewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const id = decodeURIComponent((await params).id);
  const view = (await getStore().listViews(user.id)).find((v) => v.id === id);
  if (!view) notFound();
  const s = await loadStructure(user);
  const types = loadNoteTypes().types;
  // How each note property is edited in a cell: from the notes' types, else from the values.
  const propTypes: Record<string, string> = {};
  for (const n of s.notes) {
    for (const [k, v] of Object.entries(n.props)) {
      const key = `prop:${k}`;
      if (n.rawKeys?.includes(k)) { propTypes[key] = "raw"; continue; }
      if (propTypes[key] && v === null) continue;
      if (!propTypes[key] || propTypes[key] === "text") propTypes[key] = propTypeFor(k, v, typeOf(n.props, types));
    }
  }
  const rows = view.source === "items" ? s.itemRows : s.notes;
  return (
    <Shell days={await pastDays(user.id, "")} current={`view:${view.id}`} openCount={await openCountFor(user.id)} wide>
      <p className="db-crumb"><Link className="db-link" href="/views">Views</Link></p>
      <ViewEditor
        key={view.id}
        initial={view}
        rows={rows}
        ctx={{ projects: s.projects, types: types.map((t) => t.name), propTypes, timeZone: user.timeZone, now: new Date().toISOString() }}
      />
    </Shell>
  );
}
