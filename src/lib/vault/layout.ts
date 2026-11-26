// Tabs and split panes for notes, as plain data. One or two panes side by side, each with its own
// tabs; a tab is a note's path, or "" for a new tab that hasn't picked a note yet. The layout is
// remembered per workspace in this browser (localStorage), and every read and write tolerates
// storage being off.

export interface Pane { tabs: string[]; active: number }
export interface Layout { panes: Pane[]; focus: number }

export const MAX_TABS = 20;
export const emptyLayout = (): Layout => ({ panes: [{ tabs: [], active: -1 }], focus: 0 });

const clone = (l: Layout): Layout => ({ focus: l.focus, panes: l.panes.map((p) => ({ tabs: [...p.tabs], active: p.active })) });
const fix = (p: Pane): Pane => ({ tabs: p.tabs, active: p.tabs.length ? Math.max(0, Math.min(p.active, p.tabs.length - 1)) : -1 });

export function activePath(l: Layout, pane = l.focus): string | null {
  const p = l.panes[pane];
  return p && p.active >= 0 ? p.tabs[p.active] ?? null : null;
}

/** Open a note in the focused pane: switch to its tab if open, else in this tab (or a new one). */
export function openPath(l: Layout, path: string, opts: { newTab?: boolean; pane?: number } = {}): Layout {
  const n = clone(l);
  const pi = opts.pane ?? n.focus;
  if (!n.panes[pi]) n.panes[pi] = { tabs: [], active: -1 };
  const p = n.panes[pi];
  n.focus = pi;
  const at = p.tabs.indexOf(path);
  if (at >= 0) { p.active = at; return n; }
  const cur = p.active >= 0 ? p.tabs[p.active] : null;
  if (!opts.newTab && p.active >= 0 && cur !== undefined) {
    p.tabs[p.active] = path;
  } else {
    p.tabs.splice(p.active + 1, 0, path);
    p.active = p.active + 1;
    if (p.tabs.length > MAX_TABS) { const drop = p.active === 0 ? 1 : 0; p.tabs.splice(drop, 1); if (drop < p.active) p.active--; }
  }
  // A blank "new tab" elsewhere in this pane for the same file isn't needed any more.
  return n;
}

/** ⌘T: a blank tab after the current one, in the focused pane. */
export function newTab(l: Layout): Layout {
  const n = clone(l);
  const p = n.panes[n.focus];
  const blank = p.tabs.indexOf("");
  if (blank >= 0) { p.active = blank; return n; }
  p.tabs.splice(p.active + 1, 0, "");
  p.active = p.active + 1;
  return n;
}

/** ⌘W: close a tab (the focused one by default). An emptied second pane closes too. */
export function closeTab(l: Layout, pane = l.focus, index?: number): Layout {
  const n = clone(l);
  const p = n.panes[pane];
  if (!p) return n;
  const i = index ?? p.active;
  if (i < 0 || i >= p.tabs.length) return n;
  p.tabs.splice(i, 1);
  if (p.active > i || p.active >= p.tabs.length) p.active--;
  if (!p.tabs.length && n.panes.length > 1) {
    n.panes.splice(pane, 1);
    n.focus = 0;
  }
  n.panes = n.panes.map(fix);
  n.focus = Math.min(n.focus, n.panes.length - 1);
  return n;
}

/** ⌃Tab / ⌃⇧Tab: the next or previous tab in the focused pane, wrapping. */
export function cycleTab(l: Layout, dir: 1 | -1): Layout {
  const n = clone(l);
  const p = n.panes[n.focus];
  if (p.tabs.length < 2) return n;
  p.active = (p.active + dir + p.tabs.length) % p.tabs.length;
  return n;
}

/** ⌘\: split into left and right (the current note opens on the right too), or join back into one. */
export function toggleSplit(l: Layout): Layout {
  const n = clone(l);
  if (n.panes.length === 1) {
    const cur = activePath(n);
    n.panes.push(cur !== null ? { tabs: [cur], active: 0 } : { tabs: [""], active: 0 });
    n.focus = 1;
    return n;
  }
  const [a, b] = n.panes;
  const keep = activePath(n);
  for (const t of b.tabs) if (!a.tabs.includes(t)) a.tabs.push(t);
  a.tabs = a.tabs.slice(0, MAX_TABS);
  a.active = keep !== null && a.tabs.includes(keep) ? a.tabs.indexOf(keep) : a.active;
  return { panes: [fix(a)], focus: 0 };
}

/** Open a note in the other pane, splitting first when there is only one. */
export function openToSide(l: Layout, path: string): Layout {
  let n = l.panes.length === 1 ? toggleSplit(l) : clone(l);
  const other = n.panes.length === 1 ? 0 : l.panes.length === 1 ? 1 : 1 - l.focus;
  n = openPath(n, path, { pane: other, newTab: false });
  return n;
}

export function focusPane(l: Layout, pane: number): Layout {
  if (pane === l.focus || !l.panes[pane]) return l;
  return { ...clone(l), focus: pane };
}

export function activate(l: Layout, pane: number, index: number): Layout {
  const n = clone(l);
  if (!n.panes[pane] || index < 0 || index >= n.panes[pane].tabs.length) return n;
  n.panes[pane].active = index;
  n.focus = pane;
  return n;
}

/** After a rename or move: tabs on that note (or inside that folder) follow it. */
export function renamePath(l: Layout, from: string, to: string): Layout {
  const n = clone(l);
  const map = (t: string) => (t === from ? to : t.startsWith(`${from}/`) ? `${to}${t.slice(from.length)}` : t);
  for (const p of n.panes) p.tabs = p.tabs.map(map);
  return n;
}

/** After a delete: its tabs (or those inside the folder) close. */
export function removePath(l: Layout, path: string): Layout {
  let n = clone(l);
  for (let pi = n.panes.length - 1; pi >= 0; pi--) {
    for (let i = n.panes[pi].tabs.length - 1; i >= 0; i--) {
      const t = n.panes[pi].tabs[i];
      if (t === path || t.startsWith(`${path}/`)) n = closeTab(n, pi, i);
      if (!n.panes[pi]) break;
    }
  }
  return n;
}

/** Whatever came out of storage, made safe to use. */
export function sanitizeLayout(raw: unknown): Layout {
  const o = raw as Partial<Layout> | null;
  if (!o || !Array.isArray(o.panes) || !o.panes.length) return emptyLayout();
  const panes: Pane[] = o.panes.slice(0, 2).map((p) => {
    const tabs = Array.isArray(p?.tabs) ? p.tabs.filter((t): t is string => typeof t === "string" && t.length < 1024 && !t.split("/").some((s) => s === ".." || s.startsWith("."))) : [];
    const uniq = [...new Set(tabs)].slice(0, MAX_TABS);
    return fix({ tabs: uniq, active: typeof p?.active === "number" ? p.active : 0 });
  });
  const out: Layout = { panes, focus: typeof o.focus === "number" ? Math.max(0, Math.min(o.focus, panes.length - 1)) : 0 };
  if (out.panes.length === 2 && !out.panes[1].tabs.length) return { panes: [out.panes[0]], focus: 0 };
  if (out.panes.length === 2 && !out.panes[0].tabs.length) return { panes: [out.panes[1]], focus: 0 };
  return out;
}

const key = (workspaceId: string) => `db-vault-layout:${workspaceId}`;

export function loadLayout(workspaceId: string): Layout {
  try {
    const raw = localStorage.getItem(key(workspaceId));
    return raw ? sanitizeLayout(JSON.parse(raw)) : emptyLayout();
  } catch {
    return emptyLayout();
  }
}

export function saveLayout(workspaceId: string, l: Layout): void {
  try { localStorage.setItem(key(workspaceId), JSON.stringify(l)); } catch { /* storage off: the layout lasts this visit */ }
}

const openKey = (workspaceId: string) => `db-vault-open:${workspaceId}`;

/** Which folders are expanded in the sidebar. */
export function loadExpanded(workspaceId: string): string[] {
  try {
    const raw = localStorage.getItem(openKey(workspaceId));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
  } catch {
    return [];
  }
}

export function saveExpanded(workspaceId: string, paths: string[]): void {
  try { localStorage.setItem(openKey(workspaceId), JSON.stringify(paths.slice(0, 500))); } catch { /* ignore */ }
}

/** The app URL for a note: notes/<slug>.md keeps its short /notes/<slug>. */
export function noteHref(path: string): string {
  const m = path.match(/^notes\/([\p{L}\p{N}][\p{L}\p{N}-]{0,79})\.md$/u);
  if (m) return `/notes/${encodeURIComponent(m[1])}`;
  return `/notes/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The note path a /notes/... URL names (as typed; the server resolves it). Null for /notes itself. */
export function pathFromHref(href: string): string | null {
  const m = href.match(/^\/notes\/([^?#]+)/);
  if (!m) return null;
  try { return m[1].split("/").map(decodeURIComponent).join("/"); } catch { return null; }
}
