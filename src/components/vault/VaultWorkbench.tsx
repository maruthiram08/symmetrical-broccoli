"use client";

// Notes as a workbench: the folder tree on the left, notes in tabs, and up to two panes side by
// side. ⌘T new tab, ⌘W close it, ⌘\ split or join, ⌃Tab / ⌃⇧Tab next / previous tab, ⌘⇧F focus
// mode. The layout is remembered per workspace in this browser.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { resolveNoteAction, restoreVaultEntryAction, vaultTreeAction, createVaultNoteAction } from "@/app/vault-actions";
import { FOCUS_EVENT, readFocusConf, toggleFocusMode, type FocusConf } from "@/lib/editor/focus-conf";
import {
  activate, activePath, closeTab, cycleTab, emptyLayout, focusPane, loadLayout, newTab, noteHref, openPath, openToSide,
  pathFromHref, removePath, renamePath, saveLayout, toggleSplit, type Layout,
} from "@/lib/vault/layout";
import type { TreeNode } from "@/server/local/vault";
import { FileTree, type OpenOpts } from "./FileTree";
import { VaultPane, type PaneContext } from "./VaultPane";

export interface WorkbenchContext extends PaneContext {
  rootLabel: string;
  tree: TreeNode[];
  folders: string[];
  truncated: boolean;
}

const TREE_POLL_MS = 5000;
const tabName = (t: string) => (t ? t.slice(t.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "") : "New tab");

function flatFiles(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: TreeNode[]) => { for (const n of ns) { if (n.type === "file") out.push(n.path); else walk(n.children); } };
  walk(tree);
  return out;
}

export function VaultWorkbench({ ctx, initialPath, children }: { ctx: WorkbenchContext; initialPath: string | null; children?: ReactNode }) {
  const router = useRouter();
  const [layout, setLayout] = useState<Layout>(() => (initialPath ? openPath(emptyLayout(), initialPath) : emptyLayout()));
  const [home, setHome] = useState(initialPath === null);
  const [ready, setReady] = useState(false);
  const [tree, setTree] = useState(ctx.tree);
  const [folders, setFolders] = useState(ctx.folders);
  const [filesOpen, setFilesOpen] = useState(false);
  const [focus, setFocus] = useState<FocusConf>({ on: false, unit: "paragraph", typewriter: true });
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const sig = useRef<string | undefined>(undefined);
  const lay = useRef(layout);
  lay.current = layout;

  // Bring back the remembered tabs, with this page's note in front.
  useEffect(() => {
    const saved = loadLayout(ctx.workspaceId);
    setLayout(initialPath ? openPath(saved, initialPath) : saved);
    setReady(true);
    setFocus(readFocusConf());
    const onFocus = (e: Event) => setFocus((e as CustomEvent<FocusConf>).detail);
    window.addEventListener(FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_EVENT, onFocus);
    // Once per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (ready) saveLayout(ctx.workspaceId, layout); }, [layout, ready, ctx.workspaceId]);

  // The address bar follows the note in front.
  const current = home ? null : activePath(layout);
  useEffect(() => {
    if (!ready) return;
    const href = current ? noteHref(current) : "/notes";
    if (window.location.pathname !== href) window.history.replaceState(window.history.state, "", href);
    document.title = `${current ? tabName(current) : "Notes"} · Daily brief`;
  }, [current, ready]);

  const refreshTree = useCallback(async () => {
    try {
      const r = await vaultTreeAction(sig.current);
      if (!r) return;
      sig.current = r.sig;
      if (r.tree) { setTree(r.tree); setFolders(r.folders ?? [""]); }
    } catch { /* offline: keep what is shown */ }
  }, []);

  // Files added, renamed or removed in another app show up without a reload.
  useEffect(() => {
    void refreshTree();
    const t = setInterval(() => { if (document.visibilityState === "visible") void refreshTree(); }, TREE_POLL_MS);
    const now = () => { void refreshTree(); };
    window.addEventListener("focus", now);
    return () => { clearInterval(t); window.removeEventListener("focus", now); };
  }, [refreshTree]);

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const open = useCallback((path: string, o: OpenOpts = {}) => {
    setHome(false);
    setFilesOpen(false);
    setLayout((l) => (o.side ? openToSide(l, path) : openPath(l, path, { newTab: o.newTab })));
  }, []);

  /** Links inside notes: other notes open here, in tabs; anything else navigates. */
  const navigate = useCallback((href: string, newTabWanted: boolean): boolean => {
    const target = pathFromHref(href);
    if (target === null) {
      if (newTabWanted) window.open(href, "_blank"); else router.push(href);
      return true;
    }
    void resolveNoteAction(target).then((path) => {
      if (path) open(path, { newTab: newTabWanted });
      else router.push(href);
    }).catch(() => router.push(href));
    return true;
  }, [open, router]);

  const files = useMemo(() => flatFiles(tree), [tree]);

  // Keys. Captured before the editor sees them, so ⌘\ and ⌘⇧F work while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[aria-modal="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      let handled = true;
      if (mod && e.shiftKey && !e.altKey && k === "f") toggleFocusMode();
      else if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") { setHome(false); setLayout((l) => cycleTab(l, e.shiftKey ? -1 : 1)); }
      else if (mod && !e.shiftKey && !e.altKey && k === "t") { setHome(false); setLayout((l) => newTab(l)); }
      else if (mod && !e.shiftKey && !e.altKey && k === "w") {
        const l = lay.current;
        if (!l.panes[l.focus]?.tabs.length) handled = false;
        else setLayout(closeTab(l));
      } else if (mod && !e.shiftKey && !e.altKey && (e.key === "\\" || e.code === "Backslash")) { setHome(false); setLayout((l) => toggleSplit(l)); }
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const onRenamed = useCallback((from: string, to: string) => setLayout((l) => renamePath(l, from, to)), []);
  const onTrashed = useCallback((path: string, trashed: string) => {
    setLayout((l) => removePath(l, path));
    setToast({
      text: `Moved “${tabName(path)}” to .trash`,
      undo: () => {
        void restoreVaultEntryAction(trashed, path).then((r) => {
          setToast(r.ok ? { text: "Put back" } : { text: r.error });
          void refreshTree();
        });
      },
    });
  }, [refreshTree]);

  const split = layout.panes.length > 1;
  const showHome = home || (layout.panes.length === 1 && !layout.panes[0].tabs.length);

  return (
    <div className={`db-vault${split ? " db-vault--split" : ""}${focus.on ? " db-vault--focus" : ""}`}>
      <div className="db-vault__mobilebar">
        <button type="button" className="db-act" aria-expanded={filesOpen} aria-controls="db-vault-files" onClick={() => setFilesOpen((o) => !o)}>
          {filesOpen ? "Hide files" : "Files"}
        </button>
        {split ? (
          <span className="db-vault__panepick" role="group" aria-label="Pane">
            {layout.panes.map((_, i) => (
              <button key={i} type="button" className="db-act" aria-pressed={layout.focus === i} onClick={() => setLayout((l) => focusPane(l, i))}>{i === 0 ? "Left" : "Right"}</button>
            ))}
          </span>
        ) : null}
      </div>
      <aside className="db-vault__files" id="db-vault-files" data-open={filesOpen ? "" : undefined} aria-label="Files">
        <FileTree
          tree={tree} folders={folders} active={current} workspaceId={ctx.workspaceId} rootLabel={ctx.rootLabel} truncated={ctx.truncated}
          onOpen={open} onChanged={() => void refreshTree()} onRenamed={onRenamed} onTrashed={onTrashed}
        />
      </aside>
      <div className="db-vault__main">
        {showHome && !split ? (
          <>
            <TabBar layout={layout} pane={0} home onActivate={(i) => { setHome(false); setLayout((l) => activate(l, 0, i)); }} onClose={(i) => setLayout((l) => closeTab(l, 0, i))} onNew={() => { setHome(false); setLayout((l) => newTab(l)); }} split={split} onSplit={() => { setHome(false); setLayout((l) => toggleSplit(l)); }} focus={focus} />
            <div className="db-vault__home">{children}</div>
          </>
        ) : (
          <div className="db-vault__panes">
            {layout.panes.map((pane, pi) => {
              const path = pane.active >= 0 ? pane.tabs[pane.active] : null;
              const focused = layout.focus === pi;
              return (
                <section key={pi} className="db-vault__pane" data-focused={focused ? "" : undefined} aria-label={split ? (pi === 0 ? "Left pane" : "Right pane") : "Note"}
                  onFocusCapture={() => { if (!focused) setLayout((l) => focusPane(l, pi)); }}
                  onMouseDownCapture={() => { if (!focused) setLayout((l) => focusPane(l, pi)); }}>
                  <TabBar layout={layout} pane={pi} onActivate={(i) => { setHome(false); setLayout((l) => activate(l, pi, i)); }} onClose={(i) => setLayout((l) => closeTab(l, pi, i))}
                    onNew={() => { setHome(false); setLayout((l) => newTab(focusPane(l, pi))); }} split={split} onSplit={() => setLayout((l) => toggleSplit(l))} focus={focus} showTools={pi === layout.panes.length - 1} />
                  <div className="db-vault__body">
                    {path === null ? <p className="db-section__empty">No note open. Pick one from Files, or press ⌘T.</p>
                      : path === "" ? <NewTab files={files} onPick={(p) => open(p)} onCreate={async (name) => { const r = await createVaultNoteAction("", name); if (r.ok) { void refreshTree(); open(r.path); } }} />
                        : <VaultPane key={path} path={path} ctx={ctx} autoFocus={focused} onNavigate={navigate} />}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
      {toast ? (
        <div className="db-vault__toast" role="status">
          <span>{toast.text}</span>
          {toast.undo ? <button type="button" className="db-act" onClick={() => { const u = toast.undo; setToast(null); u?.(); }}>Undo</button> : null}
        </div>
      ) : null}
    </div>
  );
}

function TabBar({ layout, pane, home, onActivate, onClose, onNew, split, onSplit, focus, showTools = true }: {
  layout: Layout; pane: number; home?: boolean; split: boolean; focus: FocusConf; showTools?: boolean;
  onActivate: (i: number) => void; onClose: (i: number) => void; onNew: () => void; onSplit: () => void;
}) {
  const p = layout.panes[pane];
  return (
    <div className="db-tabs" role="tablist" aria-label={split ? (pane === 0 ? "Left pane tabs" : "Right pane tabs") : "Open notes"}>
      <div className="db-tabs__scroll">
        {p.tabs.map((t, i) => {
          const on = !home && p.active === i;
          return (
            <div key={`${t}:${i}`} className={`db-tab${on ? " db-tab--on" : ""}`} title={t || "New tab"}>
              <button type="button" role="tab" aria-selected={on} className="db-tab__label" onClick={() => onActivate(i)} onAuxClick={(e) => { if (e.button === 1) onClose(i); }}>{tabName(t)}</button>
              <button type="button" className="db-tab__close" aria-label={`Close ${tabName(t)}`} onClick={() => onClose(i)}>×</button>
            </div>
          );
        })}
        <button type="button" className="db-tabs__new" aria-label="New tab" title="New tab (⌘T)" onClick={onNew}>+</button>
      </div>
      {showTools ? (
        <div className="db-tabs__tools">
          <button type="button" className="db-tabs__tool" aria-pressed={split} title={split ? "Join panes (⌘\\)" : "Split left and right (⌘\\)"} onClick={onSplit}>{split ? "Join" : "Split"}</button>
          <button type="button" className="db-tabs__tool" aria-pressed={focus.on} title="Focus mode (⌘⇧F)" onClick={() => toggleFocusMode()}>Focus</button>
        </div>
      ) : null}
    </div>
  );
}

function NewTab({ files, onPick, onCreate }: { files: string[]; onPick: (p: string) => void; onCreate: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const want = q.trim().toLowerCase();
  const list = useMemo(() => {
    const hits = want ? files.filter((f) => f.toLowerCase().includes(want)) : files;
    return hits.slice().sort((a, b) => {
      const an = tabName(a).toLowerCase(), bn = tabName(b).toLowerCase();
      return Number(!an.startsWith(want)) - Number(!bn.startsWith(want)) || an.localeCompare(bn);
    }).slice(0, 30);
  }, [files, want]);
  const rows: Array<{ id: string; label: string; sub?: string; run: () => void }> = list.map((f) => ({ id: f, label: tabName(f), sub: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : undefined, run: () => onPick(f) }));
  if (q.trim()) rows.push({ id: "+create", label: `Create “${q.trim()}”`, run: () => onCreate(q.trim()) });
  return (
    <div className="db-newtab">
      <input className="db-input db-newtab__input" autoFocus value={q} placeholder="Open a note, or type a name to create one" aria-label="Open a note"
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === "Enter") { e.preventDefault(); rows[sel]?.run(); }
        }} />
      <ul className="db-newtab__list" role="listbox" aria-label="Notes">
        {rows.map((r, i) => (
          <li key={r.id} role="option" aria-selected={i === sel} className="db-newtab__row" onMouseMove={() => setSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={r.run}>
            <span>{r.label}</span>{r.sub ? <span className="db-newtab__sub">{r.sub}</span> : null}
          </li>
        ))}
        {!rows.length ? <li className="db-newtab__none">No notes yet. Type a name to create one.</li> : null}
      </ul>
    </div>
  );
}
