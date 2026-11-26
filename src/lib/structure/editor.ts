// The notes editor's structure extras: #tags drawn as tags (⌘-click opens the tag), and
// "New note of type…" in the slash menu: pick it, type a title, press Enter, and the line becomes
// a link to the new note. Browser-side CodeMirror glue; the matching is pure and tested.
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { formatWikiLink } from "@/lib/editor/links";
import { slashQueryAt } from "@/lib/editor/slash";
import { findTagRanges, tagHref } from "./tags";

export { tagHref };

export interface TypeChoice { id: string; name: string }


function tagDecorations(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const text = view.state.sliceDoc();
  for (const r of findTagRanges(text)) {
    b.add(r.from, r.to, Decoration.mark({ class: "cm-md-tag", attributes: { "data-href": tagHref(r.tag), title: `#${r.tag} · ⌘-click to open` } }));
  }
  return b.finish();
}

const tagPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = tagDecorations(view); }
  update(u: ViewUpdate) { if (u.docChanged) this.decorations = tagDecorations(u.view); }
}, { decorations: (v) => v.decorations });

/** Slash menu entries for "/new…": which types match what was typed after "/". */
export function matchTypes(query: string, types: TypeChoice[]): TypeChoice[] {
  const q = query.toLowerCase();
  if (!q) return types;
  return types.filter((t) => {
    const words = ["new", "type", t.id, ...t.name.toLowerCase().split(/\s+/)];
    return words.some((w) => w.startsWith(q)) || `new${t.id}`.startsWith(q.replace(/\s+/g, ""));
  });
}

/** A typed "/new <type> <title>" line (after any list marker). */
export function parseNewLine(line: string): { indent: string; typeId: string; title: string } | null {
  const m = line.match(/^(\s*(?:[-*+]\s+)?)\/new\s+([a-z0-9][a-z0-9-]*)(?:\s+(.*))?$/i);
  if (!m) return null;
  return { indent: m[1], typeId: m[2].toLowerCase(), title: (m[3] ?? "").trim() };
}

export function typeSlashSource(types: () => TypeChoice[]): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const q = slashQueryAt(line.text.slice(0, ctx.pos - line.from));
    if (!q) return null;
    const found = matchTypes(q.query, types());
    if (!found.length) return null;
    const options: Completion[] = found.map((t, i) => ({
      label: `/new ${t.id}`,
      displayLabel: `New ${t.name.toLowerCase()}`,
      detail: "Type a title, then Enter",
      type: "slash",
      boost: -50 - i,
      apply: (view, _c, from, to) => {
        const insert = `/new ${t.id} `;
        view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.complete" });
      },
    }));
    return { from: line.from + q.from, to: ctx.pos, options, filter: false };
  };
}

export interface StructureEditorOptions {
  types: () => TypeChoice[];
  /** Make the note; resolves to its slug and title, or null. */
  create: (typeId: string, title: string) => Promise<{ slug: string; title: string } | null>;
}

/** Enter on "/new project Q4 launch" makes the note and puts a link to it on the line. */
function newNoteKeymap(o: StructureEditorOptions): Extension {
  const run = (view: EditorView): boolean => {
    const sel = view.state.selection.main;
    if (!sel.empty) return false;
    const line = view.state.doc.lineAt(sel.head);
    const cmd = parseNewLine(line.text);
    if (!cmd || !o.types().some((t) => t.id === cmd.typeId)) return false;
    const at = line.from, original = line.text;
    void o.create(cmd.typeId, cmd.title).then((r) => {
      if (!r) return;
      const cur = view.state.doc.lineAt(Math.min(at, view.state.doc.length));
      if (cur.from !== at || cur.text !== original) return;
      const insert = `${cmd.indent}${formatWikiLink("note", r.slug, r.title)}`;
      view.dispatch({ changes: { from: cur.from, to: cur.to, insert }, selection: { anchor: cur.from + insert.length }, userEvent: "input.command" });
    });
    return true;
  };
  return Prec.highest(keymap.of([{ key: "Enter", run }]));
}

export function structureExtensions(o: StructureEditorOptions): { extensions: Extension[]; completions: CompletionSource[] } {
  return { extensions: [tagPlugin, newNoteKeymap(o)], completions: [typeSlashSource(o.types)] };
}
