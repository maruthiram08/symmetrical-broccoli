// Focus mode: everything but the paragraph (or sentence) you are writing is dimmed, and the
// cursor line stays in the middle of the screen as you type (typewriter scrolling). ⌘⇧F toggles it
// for every editor at once; the choice is kept in this browser.
import { Prec, StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import { FOCUS_EVENT, readFocusConf, toggleFocusMode, type FocusConf, type FocusUnit } from "./focus-conf";

export * from "./focus-conf";

const blank = (s: string) => !s.trim();

/** The paragraph around pos: the run of non-blank lines holding it (a blank line is its own). */
export function paragraphRange(doc: Text, pos: number): { from: number; to: number } {
  const line = doc.lineAt(Math.max(0, Math.min(pos, doc.length)));
  if (blank(line.text)) return { from: line.from, to: line.to };
  let a = line.number, b = line.number;
  while (a > 1 && !blank(doc.line(a - 1).text)) a--;
  while (b < doc.lines && !blank(doc.line(b + 1).text)) b++;
  return { from: doc.line(a).from, to: doc.line(b).to };
}

/** The sentence around pos, inside its paragraph: from after the last . ! ? (or line break) to the next one. */
export function sentenceRange(doc: Text, pos: number): { from: number; to: number } {
  const para = paragraphRange(doc, pos);
  const text = doc.sliceString(para.from, para.to);
  const at = Math.max(0, Math.min(pos - para.from, text.length));
  const isEnd = (i: number) => /[.!?]/.test(text[i] ?? "") && (i + 1 >= text.length || /[\s"'”’)\]]/.test(text[i + 1]));
  // Just after a full stop you are still in the sentence it ends.
  const justEnded = at > 0 && isEnd(at - 1);
  let from = 0;
  for (let i = justEnded ? at - 2 : at - 1; i >= 0; i--) {
    if (text[i] === "\n" || isEnd(i)) { from = i + 1; break; }
  }
  while (from < at && /[ \t]/.test(text[from])) from++;
  let to = text.length;
  if (justEnded) to = at;
  else {
    for (let i = at; i < text.length; i++) {
      if (text[i] === "\n") { to = i; break; }
      if (isEnd(i)) { to = i + 1; break; }
    }
  }
  while (to < text.length && /["'”’)\]]/.test(text[to])) to++;
  return { from: para.from + from, to: para.from + to };
}

export function focusRange(doc: Text, pos: number, unit: FocusUnit) {
  return unit === "sentence" ? sentenceRange(doc, pos) : paragraphRange(doc, pos);
}

export const setFocusConf = StateEffect.define<FocusConf>();

export const focusConfField = StateField.define<FocusConf>({
  create: () => readFocusConf(),
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocusConf)) return e.value;
    return v;
  },
});

const dimLine = Decoration.line({ class: "cm-focus-dim" });
const dimMark = Decoration.mark({ class: "cm-focus-dimtext" });

/** Line and mark decorations that dim all but [from, to]. Pure, for tests. */
export function focusDecorations(doc: Text, keep: { from: number; to: number }, visible: ReadonlyArray<{ from: number; to: number }>): DecorationSet {
  const out: Range<Decoration>[] = [];
  const keepA = doc.lineAt(keep.from).number, keepB = doc.lineAt(keep.to).number;
  for (const v of visible) {
    for (let ln = doc.lineAt(v.from).number; ln <= doc.lineAt(v.to).number; ln++) {
      const line = doc.line(ln);
      if (ln < keepA || ln > keepB) { out.push(dimLine.range(line.from)); continue; }
      const a = Math.max(line.from, keep.from), b = Math.min(line.to, keep.to);
      if (a > line.from) out.push(dimMark.range(line.from, a));
      if (line.to > b) out.push(dimMark.range(b, line.to));
    }
  }
  return Decoration.set(out, true);
}

const plugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    private onEvent: (e: Event) => void;
    constructor(readonly view: EditorView) {
      this.onEvent = (e) => view.dispatch({ effects: setFocusConf.of((e as CustomEvent<FocusConf>).detail) });
      window.addEventListener(FOCUS_EVENT, this.onEvent);
      this.decorations = this.build();
    }
    update(u: ViewUpdate) {
      const conf = u.state.field(focusConfField);
      const changed = conf !== u.startState.field(focusConfField);
      if (changed || u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = this.build();
      if (conf.on && conf.typewriter && u.view.hasFocus && (u.selectionSet || u.docChanged || (changed && conf.on))) {
        const head = u.state.selection.main.head;
        requestAnimationFrame(() => {
          if (this.view.state.selection.main.head !== head) return;
          this.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
        });
      }
    }
    build(): DecorationSet {
      const conf = this.view.state.field(focusConfField);
      if (!conf.on || !this.view.hasFocus) return Decoration.none;
      const keep = focusRange(this.view.state.doc, this.view.state.selection.main.head, conf.unit);
      return focusDecorations(this.view.state.doc, keep, this.view.visibleRanges);
    }
    destroy() { window.removeEventListener(FOCUS_EVENT, this.onEvent); }
  },
  { decorations: (p) => p.decorations },
);

export function focusMode(): Extension {
  return [
    focusConfField,
    plugin,
    Prec.high(keymap.of([{ key: "Mod-Shift-f", run: () => { toggleFocusMode(); return true; } }])),
    EditorView.editorAttributes.compute([focusConfField], (s) => (s.field(focusConfField).on ? { class: "cm-focus-on" } : ({} as Record<string, string>))),
  ];
}
