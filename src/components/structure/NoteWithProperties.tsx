"use client";

// A note with YAML front matter: the front matter shows as a properties panel above the editor,
// and the editor holds only the text after it. Every save writes front matter + text, so the file
// stays byte for byte what it was apart from the edit. A note without front matter is the plain
// editor plus a "+ Properties" button.
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { LazyEditor } from "@/components/editor/LazyEditor";
import type { MarkdownEditorProps } from "@/components/editor/MarkdownEditor";
import { readProperties, splitFrontMatter } from "@/lib/structure/frontmatter";
import type { NoteType } from "@/lib/structure/note-types";
import { findTagsLite, propertyTags } from "@/lib/structure/tag-core";
import { PropertiesPanel, type LinkChoice } from "./PropertiesPanel";

/** The offline draft key for the text below the front matter. */
export const bodyDraftKey = (docKey: string) => `${docKey}#body`;

export function NoteWithProperties(p: MarkdownEditorProps & { types?: NoteType[]; links?: LinkChoice[] }) {
  const { types, links, ...editor } = p;
  const parts = useMemo(() => splitFrontMatter(p.initial), [p.initial]);
  const [fm, setFm] = useState(parts.raw);
  const fmRef = useRef(parts.raw);
  const body = useRef(parts.body);
  const [bodyText, setBodyText] = useState(parts.body);
  const [status, setStatus] = useState<string | null>(null);
  const router = useRouter();
  // One save at a time, so each carries the version the last one left.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const { save } = p;
  const saveAll = useCallback((text: string) => {
    const run = chain.current.then(() => save(text));
    chain.current = run.catch(() => undefined);
    return run;
  }, [save]);

  const onProps = (next: string) => {
    // A new type can change the page (a Project shows its board): refresh it after the save.
    const typeChanged = readProperties(fmRef.current).type !== readProperties(next).type;
    fmRef.current = next;
    setFm(next);
    setStatus("Saving…");
    const attempt = (n: number) => {
      void saveAll(next + body.current).then((r) => {
        if (fmRef.current !== next) return;
        setStatus(r.ok ? "Saved" : r.error);
        if (r.ok) setTimeout(() => setStatus((s) => (s === "Saved" ? null : s)), 1500);
        if (r.ok && typeChanged) router.refresh();
      }).catch(() => {
        if (fmRef.current !== next) return;
        setStatus("Offline: retrying");
        if (n < 5) setTimeout(() => attempt(n + 1), 3000 * (n + 1));
      });
    };
    attempt(0);
  };

  const tags = useMemo(() => {
    const props = readProperties(fm);
    return [...new Set([...propertyTags(props.tags ?? props.tag ?? null), ...findTagsLite(bodyText)])];
  }, [fm, bodyText]);

  if (p.readOnly) return <LazyEditor {...editor} />;
  return (
    <>
      <PropertiesPanel fm={fm} body={bodyText} types={types ?? []} links={links ?? []} tags={tags} onChange={onProps} status={status} />
      <LazyEditor
        {...editor}
        docKey={parts.raw ? bodyDraftKey(p.docKey) : p.docKey}
        initial={parts.body}
        save={async (md) => {
          body.current = md;
          setBodyText(md);
          return saveAll(fmRef.current + md);
        }}
      />
    </>
  );
}
