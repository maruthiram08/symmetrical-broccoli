"use client";

// The notes sidebar: every folder and .md file in the workspace folder. Click to open (⌘-click
// for a new tab, ⌥-click to open on the right), "⋯" for new, rename, move and delete. Drag a note
// or folder onto a folder to move it. Delete moves it into the folder's .trash.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import type { TreeNode } from "@/server/local/vault";
import {
  createVaultFolderAction, createVaultNoteAction, moveVaultEntryAction, renameVaultEntryAction, trashVaultEntryAction,
} from "@/app/vault-actions";
import { loadExpanded, saveExpanded } from "@/lib/vault/layout";

export interface OpenOpts { newTab?: boolean; side?: boolean }

interface Props {
  tree: TreeNode[];
  folders: string[];
  active: string | null;
  workspaceId: string;
  rootLabel: string;
  truncated?: boolean;
  onOpen: (path: string, o?: OpenOpts) => void;
  onChanged: () => void;
  onRenamed: (from: string, to: string) => void;
  onTrashed: (path: string, trashed: string) => void;
}

type Edit =
  | { kind: "rename"; path: string; type: "file" | "folder" }
  | { kind: "move"; path: string }
  | { kind: "new"; parent: string; what: "note" | "folder" };

const display = (n: TreeNode) => (n.type === "file" ? n.name.replace(/\.(md|markdown)$/i, "") : n.name);
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

export function FileTree(p: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => { setExpanded(new Set(loadExpanded(p.workspaceId))); loaded.current = true; }, [p.workspaceId]);
  useEffect(() => { if (loaded.current) saveExpanded(p.workspaceId, [...expanded]); }, [expanded, p.workspaceId]);

  // The open note's folders are always expanded.
  useEffect(() => {
    if (!p.active) return;
    const parts = p.active.split("/").slice(0, -1);
    if (!parts.length) return;
    setExpanded((s) => {
      const n = new Set(s);
      let changed = false;
      for (let i = 1; i <= parts.length; i++) { const k = parts.slice(0, i).join("/"); if (!n.has(k)) { n.add(k); changed = true; } }
      return changed ? n : s;
    });
  }, [p.active]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target as HTMLElement).closest?.(".db-tree__menu, .db-tree__more")) setMenu(null); };
    const esc = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [menu]);

  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(null), 4000); return () => clearTimeout(t); }, [error]);

  const toggle = (path: string) => setExpanded((s) => { const n = new Set(s); if (n.has(path)) n.delete(path); else n.add(path); return n; });

  const run = async <T extends { ok: boolean; error?: string }>(f: () => Promise<T>): Promise<T | null> => {
    setMenu(null);
    try {
      const r = await f();
      if (!r.ok) setError(r.error ?? "Couldn't do that.");
      return r.ok ? r : null;
    } catch {
      setError("Couldn't reach Daily brief.");
      return null;
    }
  };

  const create = async (parent: string, what: "note" | "folder", name: string) => {
    setEdit(null);
    if (parent) setExpanded((s) => new Set(s).add(parent));
    if (what === "note") {
      const r = await run(() => createVaultNoteAction(parent, name));
      if (r && "path" in r) { p.onChanged(); p.onOpen(r.path as string); }
    } else {
      const r = await run(() => createVaultFolderAction(parent, name));
      if (r && "path" in r) { setExpanded((s) => new Set(s).add(r.path as string)); p.onChanged(); }
    }
  };

  const rename = async (path: string, name: string) => {
    setEdit(null);
    const r = await run(() => renameVaultEntryAction(path, name));
    if (r && "path" in r && r.path !== path) { p.onRenamed(path, r.path as string); p.onChanged(); }
  };

  const move = async (path: string, folder: string) => {
    setEdit(null);
    if (parentOf(path) === folder) return;
    const r = await run(() => moveVaultEntryAction(path, folder));
    if (r && "path" in r) {
      if (expanded.has(path)) setExpanded((s) => { const n = new Set(s); n.delete(path); n.add(r.path as string); return n; });
      p.onRenamed(path, r.path as string);
      p.onChanged();
    }
  };

  const trash = async (path: string) => {
    const r = await run(() => trashVaultEntryAction(path));
    if (r && "trashed" in r) { p.onTrashed(path, r.trashed as string); p.onChanged(); }
  };

  const onDrag = (e: DragEvent, path: string) => { e.dataTransfer.setData("text/x-db-note", path); e.dataTransfer.effectAllowed = "move"; };
  const dropProps = (folder: string) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes("text/x-db-note")) { e.preventDefault(); e.stopPropagation(); setDragOver(folder); } },
    onDragLeave: () => setDragOver((d) => (d === folder ? null : d)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(null);
      const from = e.dataTransfer.getData("text/x-db-note");
      if (from && from !== folder && !(folder + "/").startsWith(from + "/")) void move(from, folder);
    },
  });

  const openClick = (e: MouseEvent, path: string) => {
    e.preventDefault();
    p.onOpen(path, { newTab: e.metaKey || e.ctrlKey || e.button === 1, side: e.altKey });
  };

  const empty = !p.tree.length;

  const row = (n: TreeNode, depth: number) => {
    const isOpen = n.type === "folder" && expanded.has(n.path);
    const pad = { paddingLeft: 8 + depth * 14 };
    const renaming = edit?.kind === "rename" && edit.path === n.path;
    return (
      <li key={n.path} role="treeitem" aria-expanded={n.type === "folder" ? isOpen : undefined} aria-selected={n.path === p.active}>
        <div
          className={`db-tree__row${n.path === p.active ? " db-tree__row--active" : ""}${dragOver === n.path ? " db-tree__row--drop" : ""}`}
          draggable={!renaming}
          onDragStart={(e) => onDrag(e, n.path)}
          {...(n.type === "folder" ? dropProps(n.path) : {})}
        >
          {renaming ? (
            <NameInput initial={display(n)} style={pad} label={`Rename ${display(n)}`} onDone={(v) => (v && v !== display(n) ? void rename(n.path, v) : setEdit(null))} />
          ) : n.type === "folder" ? (
            <button type="button" className="db-tree__btn" style={pad} onClick={() => toggle(n.path)} title={n.path}>
              <span className={`db-tree__caret${isOpen ? " db-tree__caret--open" : ""}`} aria-hidden="true">▸</span>
              <span className="db-tree__name">{n.name}</span>
            </button>
          ) : (
            <a className="db-tree__btn" style={pad} href={`/notes/${n.path.split("/").map(encodeURIComponent).join("/")}`} onClick={(e) => openClick(e, n.path)} onAuxClick={(e) => { if (e.button === 1) openClick(e, n.path); }} title={n.path}>
              <span className="db-tree__icon" aria-hidden="true" />
              <span className="db-tree__name">{display(n)}</span>
            </a>
          )}
          {!renaming ? (
            <button type="button" className="db-tree__more" aria-label={`More for ${display(n)}`} aria-haspopup="menu" aria-expanded={menu === n.path} onClick={() => setMenu((m) => (m === n.path ? null : n.path))}>⋯</button>
          ) : null}
          {menu === n.path ? (
            <div className="db-tree__menu" role="menu">
              {n.type === "file" ? (
                <>
                  <button role="menuitem" type="button" onClick={() => { setMenu(null); p.onOpen(n.path, { newTab: true }); }}>Open in new tab</button>
                  <button role="menuitem" type="button" onClick={() => { setMenu(null); p.onOpen(n.path, { side: true }); }}>Open to the right</button>
                </>
              ) : (
                <>
                  <button role="menuitem" type="button" onClick={() => { setMenu(null); setExpanded((s) => new Set(s).add(n.path)); setEdit({ kind: "new", parent: n.path, what: "note" }); }}>New note here</button>
                  <button role="menuitem" type="button" onClick={() => { setMenu(null); setExpanded((s) => new Set(s).add(n.path)); setEdit({ kind: "new", parent: n.path, what: "folder" }); }}>New folder here</button>
                </>
              )}
              <button role="menuitem" type="button" onClick={() => { setMenu(null); setEdit({ kind: "rename", path: n.path, type: n.type }); }}>Rename</button>
              <button role="menuitem" type="button" onClick={() => { setMenu(null); setEdit({ kind: "move", path: n.path }); }}>Move to…</button>
              <button role="menuitem" type="button" className="db-tree__danger" onClick={() => void trash(n.path)}>Delete</button>
            </div>
          ) : null}
        </div>
        {edit?.kind === "move" && edit.path === n.path ? (
          <MovePicker path={n.path} folders={p.folders} onCancel={() => setEdit(null)} onMove={(f) => void move(n.path, f)} />
        ) : null}
        {n.type === "folder" && isOpen ? (
          <ul role="group" className="db-tree__list">
            {edit?.kind === "new" && edit.parent === n.path ? (
              <li><NameInput initial="" style={{ paddingLeft: 8 + (depth + 1) * 14 }} label={edit.what === "note" ? "New note name" : "New folder name"} placeholder={edit.what === "note" ? "Note name" : "Folder name"} onDone={(v) => (v ? void create(n.path, edit.what, v) : setEdit(null))} /></li>
            ) : null}
            {n.children.map((c) => row(c, depth + 1))}
            {!n.children.length && !(edit?.kind === "new" && edit.parent === n.path) ? <li className="db-tree__empty" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>Empty</li> : null}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="db-tree" {...dropProps("")} data-drop={dragOver === "" ? "" : undefined}>
      <div className="db-tree__head">
        <span className="db-tree__title" title={p.rootLabel}>Files</span>
        <button type="button" className="db-tree__add" onClick={() => setEdit({ kind: "new", parent: "", what: "note" })} aria-label="New note" title="New note">+ Note</button>
        <button type="button" className="db-tree__add" onClick={() => setEdit({ kind: "new", parent: "", what: "folder" })} aria-label="New folder" title="New folder">+ Folder</button>
      </div>
      {error ? <p className="db-tree__error" role="alert">{error}</p> : null}
      <ul className="db-tree__list" role="tree" aria-label="Notes">
        {edit?.kind === "new" && edit.parent === "" ? (
          <li><NameInput initial="" style={{ paddingLeft: 8 }} label={edit.what === "note" ? "New note name" : "New folder name"} placeholder={edit.what === "note" ? "Note name" : "Folder name"} onDone={(v) => (v ? void create("", edit.what, v) : setEdit(null))} /></li>
        ) : null}
        {p.tree.map((n) => row(n, 0))}
      </ul>
      {empty ? <p className="db-tree__hint">No notes in this folder yet.</p> : null}
      {p.truncated ? <p className="db-tree__hint">This folder is very large; only the first 20,000 entries are shown.</p> : null}
      <p className="db-tree__root db-mono" title={p.rootLabel}>{p.rootLabel}</p>
    </div>
  );
}

function NameInput({ initial, onDone, label, placeholder, style }: { initial: string; onDone: (v: string | null) => void; label: string; placeholder?: string; style?: React.CSSProperties }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (val: string | null) => { if (done.current) return; done.current = true; onDone(val); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); finish(v.trim() || null); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
  };
  return (
    <div className="db-tree__edit" style={style}>
      <input className="db-tree__input" autoFocus value={v} aria-label={label} placeholder={placeholder} maxLength={120}
        onChange={(e) => setV(e.target.value)} onKeyDown={onKey} onBlur={() => finish(v.trim() && v.trim() !== initial ? v.trim() : null)}
        onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

function MovePicker({ path, folders, onMove, onCancel }: { path: string; folders: string[]; onMove: (folder: string) => void; onCancel: () => void }) {
  const options = useMemo(() => folders.filter((f) => f !== path && !f.startsWith(`${path}/`) && f !== parentOf(path)), [folders, path]);
  const [to, setTo] = useState(options[0] ?? "");
  if (!options.length) return <div className="db-tree__move"><span>There’s no other folder to move it to.</span><button type="button" className="db-act" onClick={onCancel}>OK</button></div>;
  return (
    <div className="db-tree__move">
      <select className="db-tree__select" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Move to folder" autoFocus>
        {options.map((f) => <option key={f} value={f}>{f || "Top level"}</option>)}
      </select>
      <button type="button" className="db-act db-act--primary" onClick={() => onMove(to)}>Move</button>
      <button type="button" className="db-act" onClick={onCancel}>Cancel</button>
    </div>
  );
}
