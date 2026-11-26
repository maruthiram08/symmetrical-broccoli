"use client";

// A free-form note page: the whole file is the editor. Saves carry the hash of the version the
// editor started from, so a change made in another app is kept as a copy, never overwritten.
// YAML front matter shows as a properties panel above the text (src/components/structure); the
// file is saved as front matter + text, byte for byte as they are.
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { saveNoteAction } from "@/app/notes-actions";
import { readProperties, splitFrontMatter } from "@/lib/structure/frontmatter";
import type { NoteType } from "@/lib/structure/note-types";
import { findTagsLite, propertyTags } from "@/lib/structure/tag-core";
import { PropertiesPanel, type LinkChoice } from "../structure/PropertiesPanel";
import { LazyEditor as MarkdownEditor } from "./LazyEditor";

export function NoteEditor(p: { slug: string; initial: string; hash: string; timeZone: string; today: string; assist: { enabled: boolean; reason?: string }; notes: Array<{ slug: string; title: string }>; types?: NoteType[]; links?: LinkChoice[] }) {
  const base = useRef<string>(p.hash);
  const [conflict, setConflict] = useState<string | null>(null);
  const parts = useMemo(() => splitFrontMatter(p.initial), [p.initial]);
  const [fm, setFm] = useState(parts.raw);
  const fmRef = useRef(parts.raw);
  const body = useRef(parts.body);
  const [bodyText, setBodyText] = useState(parts.body);
  const [propStatus, setPropStatus] = useState<string | null>(null);
  // One save at a time, so each carries the hash the last one left.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const saveAll = useCallback((text: string) => {
    const run = chain.current.then(async () => {
      const r = await saveNoteAction(p.slug, text, base.current);
      if (r.ok) { base.current = r.hash; if (r.conflict) setConflict(r.conflict); return { ok: true as const }; }
      return r;
    });
    chain.current = run.catch(() => undefined);
    return run;
  }, [p.slug]);

  const router = useRouter();
  const onProps = (next: string) => {
    // A new type can change the page (a Project shows its board): refresh it after the save.
    const typeChanged = readProperties(fmRef.current).type !== readProperties(next).type;
    fmRef.current = next;
    setFm(next);
    setPropStatus("Saving…");
    const attempt = (n: number) => {
      void saveAll(next + body.current).then((r) => {
        if (fmRef.current !== next) return;
        setPropStatus(r.ok ? "Saved" : r.error);
        if (r.ok) setTimeout(() => setPropStatus((s) => (s === "Saved" ? null : s)), 1500);
        if (r.ok && typeChanged) router.refresh();
      }).catch(() => {
        if (fmRef.current !== next) return;
        setPropStatus("Offline: retrying");
        if (n < 5) setTimeout(() => attempt(n + 1), 3000 * (n + 1));
      });
    };
    attempt(0);
  };

  const tags = useMemo(() => {
    const props = readProperties(fm);
    return [...new Set([...propertyTags(props.tags ?? props.tag ?? null), ...findTagsLite(bodyText)])];
  }, [fm, bodyText]);

  return (
    <div className="db-note">
      {conflict ? (
        <p className="db-banner" role="status">
          This note changed in another app while it was open. That version is kept as <span className="db-mono">notes/{conflict}</span>.
        </p>
      ) : null}
      <PropertiesPanel fm={fm} body={bodyText} types={p.types ?? []} links={p.links ?? []} tags={tags} onChange={onProps} status={propStatus} />
      <MarkdownEditor
        docKey={parts.raw ? `note-body:${p.slug}` : `note:${p.slug}`}
        initial={parts.body}
        save={async (md) => {
          body.current = md;
          setBodyText(md);
          return saveAll(fmRef.current + md);
        }}
        timeZone={p.timeZone}
        today={p.today}
        assist={p.assist}
        notes={p.notes}
        label="Note"
        autoFocus
        placeholder="# Title, then anything. Type / for commands, [[ to link, # to tag."
        idleText={`Saved as notes/${p.slug}.md`}
      />
    </div>
  );
}
