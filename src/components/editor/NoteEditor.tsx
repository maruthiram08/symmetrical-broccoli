"use client";

// A free-form note page: the whole file is the editor. Saves carry the hash of the version the
// editor started from, so a change made in another app is kept as a copy, never overwritten.
import { useRef, useState } from "react";
import { saveNoteAction } from "@/app/notes-actions";
import { LazyEditor as MarkdownEditor } from "./LazyEditor";

export function NoteEditor(p: { slug: string; initial: string; hash: string; timeZone: string; today: string; assist: { enabled: boolean; reason?: string }; notes: Array<{ slug: string; title: string }> }) {
  const base = useRef<string>(p.hash);
  const [conflict, setConflict] = useState<string | null>(null);
  return (
    <div className="db-note">
      {conflict ? (
        <p className="db-banner" role="status">
          This note changed in another app while it was open. That version is kept as <span className="db-mono">notes/{conflict}</span>.
        </p>
      ) : null}
      <MarkdownEditor
        docKey={`note:${p.slug}`}
        initial={p.initial}
        save={async (md) => {
          const r = await saveNoteAction(p.slug, md, base.current);
          if (r.ok) { base.current = r.hash; if (r.conflict) setConflict(r.conflict); return { ok: true }; }
          return r;
        }}
        timeZone={p.timeZone}
        today={p.today}
        assist={p.assist}
        notes={p.notes}
        label="Note"
        autoFocus
        placeholder="# Title, then anything. Type / for commands, [[ to link."
        idleText={`Saved as notes/${p.slug}.md`}
      />
    </div>
  );
}
