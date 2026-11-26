"use client";

// One note in a pane: any .md file in the workspace folder, edited in place. A save carries the
// hash of the version the editor started from, so an edit made in another app at the same time is
// kept as a conflict copy, never lost. While you aren't typing, a change made on disk elsewhere
// (Obsidian, git pull, iCloud) is picked up within a few seconds.
import { useCallback, useEffect, useRef, useState } from "react";
import { readVaultNoteAction, saveVaultNoteAction, statVaultNoteAction, vaultBacklinksAction } from "@/app/vault-actions";
import type { Backlink } from "@/lib/editor/links";
import type { VaultNote } from "@/server/local/vault";
import { LazyEditor } from "@/components/editor/LazyEditor";
import { readDraft } from "@/components/editor/useAutosave";

export interface PaneContext {
  workspaceId: string;
  timeZone: string;
  today: string;
  assist: { enabled: boolean; reason?: string };
  notes: Array<{ slug: string; title: string }>;
}

const POLL_MS = 3000;

export function VaultPane({ path, ctx, autoFocus, onNavigate, onGone }: {
  path: string;
  ctx: PaneContext;
  autoFocus?: boolean;
  onNavigate: (href: string, newTab: boolean) => boolean;
  onGone?: (path: string) => void;
}) {
  const [note, setNote] = useState<VaultNote | null | undefined>(undefined);
  const [version, setVersion] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [links, setLinks] = useState<Backlink[] | null>(null);
  const base = useRef("");
  const saving = useRef(false);
  const docKey = `vault:${ctx.workspaceId}:${path}`;

  useEffect(() => {
    let live = true;
    setNote(undefined);
    readVaultNoteAction(path).then((n) => { if (!live) return; base.current = n?.hash ?? ""; setNote(n); }).catch(() => { if (live) setNote(null); });
    return () => { live = false; };
  }, [path]);

  useEffect(() => {
    if (!note) return;
    let live = true;
    vaultBacklinksAction(path).then((b) => { if (live) setLinks(b); }).catch(() => {});
    return () => { live = false; };
  }, [path, note, version]);

  // Notice edits made outside the app.
  const check = useCallback(async () => {
    if (saving.current || document.visibilityState === "hidden" || !base.current) return;
    let st: Awaited<ReturnType<typeof statVaultNoteAction>> = null;
    try { st = await statVaultNoteAction(path); } catch { return; }
    if (saving.current) return;
    if (!st) { setNotice("This note was moved or deleted outside Daily brief."); onGone?.(path); return; }
    if (st.hash === base.current) return;
    if (readDraft(docKey)) { setNotice("Changed in another app too. Your next save keeps that version as a copy."); return; }
    const n = await readVaultNoteAction(path).catch(() => null);
    if (!n || saving.current || readDraft(docKey)) return;
    base.current = n.hash;
    setNote(n);
    setVersion((v) => v + 1);
    setNotice("Updated from disk");
  }, [path, docKey, onGone]);

  useEffect(() => {
    const t = setInterval(() => { void check(); }, POLL_MS);
    const now = () => { void check(); };
    window.addEventListener("focus", now);
    return () => { clearInterval(t); window.removeEventListener("focus", now); };
  }, [check]);

  useEffect(() => { if (notice !== "Updated from disk") return; const t = setTimeout(() => setNotice(null), 2500); return () => clearTimeout(t); }, [notice]);

  if (note === undefined) return <div className="db-vpane__loading" aria-busy="true">Opening…</div>;
  if (note === null) return <div className="db-vpane__missing"><p>“{path}” isn’t in this folder any more.</p></div>;

  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const crumbs = folder ? folder.split("/") : [];

  return (
    <div className="db-vpane">
      <div className="db-vpane__crumbs" aria-label="Folder">
        {crumbs.map((c, i) => <span key={i} className="db-vpane__crumb">{c}</span>)}
        <span className="db-vpane__crumb db-vpane__crumb--here">{note.name}</span>
      </div>
      {conflict ? (
        <p className="db-banner" role="status">
          This note changed in another app while it was open. That version is kept as <span className="db-mono">{conflict}</span>.
        </p>
      ) : null}
      {notice ? <p className="db-vpane__notice" role="status">{notice}</p> : null}
      {note.readOnly ? <p className="db-vpane__notice" role="status">This file isn’t plain UTF-8 text (or is very large), so it’s open read-only to keep its bytes exactly as they are.</p> : null}
      <LazyEditor
        key={`${path}:${version}`}
        docKey={docKey}
        initial={note.markdown}
        save={async (md) => {
          saving.current = true;
          try {
            const r = await saveVaultNoteAction(path, md, base.current);
            if (r.ok) { base.current = r.hash; if (r.conflict) setConflict(r.conflict); setNotice(null); return { ok: true }; }
            return r;
          } finally {
            saving.current = false;
          }
        }}
        timeZone={ctx.timeZone}
        today={ctx.today}
        assist={ctx.assist}
        notes={ctx.notes}
        label={note.name}
        autoFocus={autoFocus}
        readOnly={note.readOnly}
        assetBase={folder}
        onNavigate={onNavigate}
        placeholder="Write anything. Type / for commands, [[ to link."
        idleText={`Saved as ${path}`}
      />
      {links && links.length ? (
        <section className="db-vpane__links" aria-label="Linked from">
          <h2 className="db-vpane__links-title">Linked from <span className="db-section__count">{links.length}</span></h2>
          <ul>
            {links.map((b) => (
              <li key={`${b.type}:${b.id}`}>
                <a href={b.href} onClick={(e) => { if (onNavigate(b.href, e.metaKey || e.ctrlKey)) e.preventDefault(); }}>{b.title}</a>
                {b.snippets[0] ? <span className="db-vpane__snip">{b.snippets[0]}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
