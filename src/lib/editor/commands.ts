// Keyboard and menus for the notes editor: the slash menu, [[ link autocomplete, line commands
// on Enter, and formatting keys. Browser-side CodeMirror glue over the pure parts in slash.ts
// and links.ts.
import { startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from "@codemirror/autocomplete";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { formatWikiLink, type LinkKind } from "./links";
import { filterCommands, insertFor, parseLineCommand, slashQueryAt, type SlashId } from "./slash";

export interface LinkTarget {
  kind: LinkKind;
  /** What goes after "kind:" in the link: a name, slug, id or date. */
  target: string;
  label: string;
  /** Second line in the menu: "Meeting · 25 Nov", "You owe · Nitin". */
  detail?: string;
}

const KIND_ORDER: Record<LinkKind, number> = { person: 0, note: 1, meeting: 2, item: 3, day: 4 };

/** Link menu options for what was typed after "[[" (an optional "kind:" narrows it). */
export function matchTargets(query: string, targets: LinkTarget[], limit = 30): LinkTarget[] {
  const m = query.match(/^(person|note|meeting|item|day):(.*)$/i);
  const kind = m ? (m[1].toLowerCase() as LinkKind) : null;
  const q = (m ? m[2] : query).trim().toLowerCase();
  const scored: Array<[LinkTarget, number]> = [];
  for (const t of targets) {
    if (kind && t.kind !== kind) continue;
    const label = t.label.toLowerCase();
    let s: number;
    if (!q) s = 3;
    else if (label.startsWith(q)) s = 0;
    else if (label.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q))) s = 1;
    else if (label.includes(q) || t.target.toLowerCase().includes(q)) s = 2;
    else continue;
    scored.push([t, s]);
  }
  return scored.sort((a, b) => a[1] - b[1] || KIND_ORDER[a[0].kind] - KIND_ORDER[b[0].kind]).slice(0, limit).map(([t]) => t);
}

/** The replacement for "[[query" (and an auto-closed "]]" after the cursor). */
export function linkText(t: LinkTarget): string {
  return t.kind === "person" ? formatWikiLink("person", t.target) : formatWikiLink(t.kind, t.target, t.label);
}

const KIND_LABEL: Record<LinkKind, string> = { person: "Person", note: "Note", meeting: "Meeting", item: "Item", day: "Day" };

export function linkSource(targets: () => LinkTarget[], newNote?: (title: string) => Promise<string | null>): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\[\[[^[\]\n]*$/);
    if (!before) return null;
    const query = before.text.slice(2);
    const found = matchTargets(query, targets());
    const close = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "]]" ? 2 : 0;
    const options: Completion[] = found.map((t, i) => ({
      label: t.label,
      detail: t.detail ?? KIND_LABEL[t.kind],
      type: t.kind,
      boost: -i,
      apply: (view, _c, from, to) => {
        const text = linkText(t);
        view.dispatch({ changes: { from, to: to + close, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.complete" });
      },
    }));
    const plain = query.replace(/^(?:person|note|meeting|item|day):/i, "").trim();
    if (plain && newNote && !found.some((t) => t.kind === "note" && t.label.toLowerCase() === plain.toLowerCase()) && !/^(?:person|meeting|item|day):/i.test(query)) {
      options.push({
        label: `New note “${plain}”`,
        detail: "Note",
        type: "note",
        boost: -999,
        apply: (view, _c, from, to) => {
          void newNote(plain).then((slug) => {
            if (!slug) return;
            const text = formatWikiLink("note", slug, plain);
            view.dispatch({ changes: { from, to: to + close, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.complete" });
          });
        },
      });
    }
    return { from: before.from, to: ctx.pos, options, filter: false };
  };
}

export function slashSource(today: () => string): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const q = slashQueryAt(before);
    if (!q) return null;
    const from = line.from + q.from;
    const options: Completion[] = filterCommands(q.query).map((c, i) => ({
      label: `/${c.id}`,
      displayLabel: c.label,
      detail: c.hint,
      type: "slash",
      boost: -i,
      // The menu stays open while you type, so read the line again when a command is picked.
      apply: (view: EditorView, _c: Completion, f: number, t: number) => {
        const l = view.state.doc.lineAt(f);
        applySlash(view, c.id, f, t, today(), l.text.slice(0, f - l.from), l.text.slice(t - l.from));
      },
    }));
    return { from, to: ctx.pos, options, filter: false };
  };
}

function applySlash(view: EditorView, id: SlashId, from: number, to: number, today: string, prefix: string, lineAfter: string) {
  const line = view.state.doc.lineAt(from);
  const ins = insertFor(id, { today, lineRest: (prefix.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|>\s*|#+\s+)?/, "") + lineAfter).trim(), prefix });
  const start = ins.wholeLine ? line.from : from;
  const end = ins.wholeLine ? line.to : to;
  const anchor = start + (ins.cursor ?? ins.text.length);
  const head = ins.selectTo !== undefined ? start + ins.selectTo : anchor;
  view.dispatch({ changes: { from: start, to: end, insert: ins.text }, selection: EditorSelection.range(anchor, head), userEvent: "input.complete", scrollIntoView: true });
  if (ins.complete) queueMicrotask(() => startCompletion(view));
}

export interface LineCommandHandler {
  /** Runs /todo, /owe, /waiting, /decision, /date. Resolves to the finished line, or null to leave it. */
  run(cmd: NonNullable<ReturnType<typeof parseLineCommand>>): Promise<string | null> | string | null;
}

/** Enter on a "/todo ..." line runs it; the line is replaced when the command finishes. */
export function lineCommandKeymap(h: LineCommandHandler): Extension {
  const run = (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const line = view.state.doc.lineAt(sel.head);
    const cmd = parseLineCommand(line.text);
    if (!cmd || !cmd.arg && cmd.id !== "date") return false;
    const original = line.text;
    const at = line.from;
    void Promise.resolve(h.run(cmd)).then((next) => {
      if (next == null) return;
      // Only if the line is still what we ran.
      const cur = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
      if (cur.from !== at || cur.text !== original) return;
      const insert = `${next}\n`;
      view.dispatch({ changes: { from: cur.from, to: cur.to + (cur.to < view.state.doc.length ? 1 : 0), insert }, selection: { anchor: cur.from + insert.length }, userEvent: "input.command", scrollIntoView: true });
    });
    return true;
  };
  return Prec.high(keymap.of([{ key: "Enter", run }]));
}

/** Wrap the selection in a marker ("**"), or unwrap when it already is. */
export function toggleWrap(marker: string) {
  return (view: EditorView): boolean => {
    const changes = view.state.changeByRange((r) => {
      const n = marker.length;
      const before = view.state.sliceDoc(r.from - n, r.from), after = view.state.sliceDoc(r.to, r.to + n);
      if (before === marker && after === marker) {
        return { changes: [{ from: r.from - n, to: r.from }, { from: r.to, to: r.to + n }], range: EditorSelection.range(r.from - n, r.to - n) };
      }
      return { changes: [{ from: r.from, insert: marker }, { from: r.to, insert: marker }], range: EditorSelection.range(r.from + n, r.to + n) };
    });
    view.dispatch(changes, { userEvent: "input.format" });
    return true;
  };
}

/** Cycle the line: text -> "- [ ] text" -> "- [x] text" -> "- [ ] text". */
export function toggleTaskLine(view: EditorView): boolean {
  const changes = view.state.changeByRange((r) => {
    const line = view.state.doc.lineAt(r.head);
    const m = line.text.match(/^(\s*)([-*+])\s+\[([ xX])\]\s/);
    if (m) {
      const at = line.from + line.text.indexOf("[", m[1].length + 1) + 1;
      return { changes: { from: at, to: at + 1, insert: m[3] === " " ? "x" : " " }, range: r };
    }
    const list = line.text.match(/^(\s*)([-*+])\s+/);
    if (list) {
      const at = line.from + list[0].length;
      return { changes: { from: at, insert: "[ ] " }, range: EditorSelection.cursor(r.head + 4) };
    }
    const lead = line.text.match(/^\s*/)![0].length;
    return { changes: { from: line.from + lead, insert: "- [ ] " }, range: EditorSelection.cursor(r.head + 6) };
  });
  view.dispatch(changes, { userEvent: "input.format" });
  return true;
}

export function insertLinkStart(view: EditorView): boolean {
  const r = view.state.selection.main;
  const text = view.state.sliceDoc(r.from, r.to);
  view.dispatch({ changes: { from: r.from, to: r.to, insert: `[[${text}` }, selection: { anchor: r.from + 2 + text.length }, userEvent: "input" });
  startCompletion(view);
  return true;
}

export function formattingKeymap(extra: KeyBinding[] = []): Extension {
  return keymap.of([
    { key: "Mod-b", run: toggleWrap("**") },
    { key: "Mod-i", run: toggleWrap("*") },
    { key: "Mod-Shift-x", run: toggleWrap("~~") },
    { key: "Mod-e", run: toggleWrap("`") },
    { key: "Mod-k", run: insertLinkStart },
    { key: "Mod-Enter", run: toggleTaskLine },
    ...extra,
  ]);
}
