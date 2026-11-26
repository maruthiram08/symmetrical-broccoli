// Live preview for CodeMirror: turns the specs from preview-specs.ts into decorations and widgets
// (checkboxes, link chips, callout labels, tables, toggles). Browser-only parts live here.
import { foldEffect, syntaxTree, unfoldEffect } from "@codemirror/language";
import { StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { previewSpecs, type Spec } from "./preview-specs";
import type { LinkResolver } from "./links";

export const setFocused = StateEffect.define<boolean>();

const focusField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return v;
  },
});

class CheckWidget extends WidgetType {
  constructor(readonly checked: boolean) { super(); }
  eq(o: CheckWidget) { return o.checked === this.checked; }
  toDOM() {
    const box = document.createElement("span");
    box.className = `cm-md-check${this.checked ? " cm-md-check--on" : ""}`;
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.setAttribute("aria-label", this.checked ? "Done" : "Not done");
    box.dataset.check = "1";
    return box;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-md-bullet"; s.textContent = "•"; return s; }
}

class LinkWidget extends WidgetType {
  constructor(readonly label: string, readonly href: string, readonly kind: string | null) { super(); }
  eq(o: LinkWidget) { return o.label === this.label && o.href === this.href && o.kind === this.kind; }
  toDOM() {
    const a = document.createElement("a");
    a.className = `cm-md-wiki cm-md-wiki--${this.kind ?? "any"}`;
    a.href = this.href;
    a.textContent = this.label;
    a.dataset.href = this.href;
    return a;
  }
  ignoreEvent() { return false; }
}

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-md-hr"; s.setAttribute("role", "separator"); return s; }
}

const CALLOUT_LABELS: Record<string, string> = { note: "Note", info: "Info", tip: "Tip", warning: "Warning", decision: "Decision", important: "Important", todo: "To do", question: "Question" };

class CalloutWidget extends WidgetType {
  constructor(readonly kind: string) { super(); }
  eq(o: CalloutWidget) { return o.kind === this.kind; }
  toDOM() {
    const s = document.createElement("span");
    s.className = `cm-md-callout-label cm-md-callout-label--${this.kind}`;
    s.textContent = CALLOUT_LABELS[this.kind] ?? this.kind[0].toUpperCase() + this.kind.slice(1);
    return s;
  }
}

class ToggleWidget extends WidgetType {
  constructor(readonly title: string, readonly folded: boolean, readonly foldFrom: number, readonly foldTo: number) { super(); }
  eq(o: ToggleWidget) { return o.title === this.title && o.folded === this.folded && o.foldFrom === this.foldFrom && o.foldTo === this.foldTo; }
  toDOM() {
    const b = document.createElement("span");
    b.className = `cm-md-toggle${this.folded ? " cm-md-toggle--folded" : ""}`;
    b.dataset.toggle = `${this.foldFrom}:${this.foldTo}:${this.folded ? 1 : 0}`;
    b.setAttribute("role", "button");
    b.setAttribute("aria-expanded", String(!this.folded));
    const caret = document.createElement("span");
    caret.className = "cm-md-toggle__caret";
    caret.textContent = "▸";
    b.append(caret, document.createTextNode(this.title));
    return b;
  }
  ignoreEvent() { return false; }
}

/** Inline Markdown in a table cell, drawn simply: links by label, markup removed. */
function cellText(s: string): string {
  return s
    .replace(/\[\[(?:[a-z]+:)?([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_m, t, l) => l ?? t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`|\*|_)(.+?)\1/g, "$2");
}

class TableWidget extends WidgetType {
  constructor(readonly rows: string[][], readonly align: Array<string | null>, readonly from: number) { super(); }
  eq(o: TableWidget) { return JSON.stringify(o.rows) === JSON.stringify(this.rows) && o.align.join() === this.align.join() && o.from === this.from; }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-md-tablewrap";
    wrap.dataset.tableFrom = String(this.from);
    const t = document.createElement("table");
    t.className = "cm-md-table";
    this.rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      r.forEach((c, k) => {
        const cell = document.createElement(i === 0 ? "th" : "td");
        cell.textContent = cellText(c);
        const a = this.align[k];
        if (a) cell.style.textAlign = a;
        tr.append(cell);
      });
      t.append(tr);
    });
    wrap.append(t);
    return wrap;
  }
  ignoreEvent() { return false; }
}

class HintWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(o: HintWidget) { return o.text === this.text; }
  toDOM() { const s = document.createElement("span"); s.className = "cm-md-hint"; s.textContent = `↵ ${this.text.replace(/^Enter /, "")}`; return s; }
}

export function toDecorations(specs: Spec[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const s of specs) {
    switch (s.t) {
      case "hide": if (s.to > s.from) ranges.push(Decoration.replace({}).range(s.from, s.to)); break;
      case "mark": if (s.to > s.from) ranges.push(Decoration.mark({ class: s.cls, attributes: s.attrs }).range(s.from, s.to)); break;
      case "line": ranges.push(Decoration.line({ class: s.cls }).range(s.at)); break;
      case "check": ranges.push(Decoration.replace({ widget: new CheckWidget(s.checked) }).range(s.from, s.to)); break;
      case "bullet": ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(s.from, s.to)); break;
      case "link": ranges.push(Decoration.replace({ widget: new LinkWidget(s.label, s.href, s.kind) }).range(s.from, s.to)); break;
      case "hr": ranges.push(Decoration.replace({ widget: new HrWidget() }).range(s.from, s.to)); break;
      case "callout": ranges.push(Decoration.replace({ widget: new CalloutWidget(s.kind) }).range(s.from, s.to)); break;
      case "toggle": ranges.push(Decoration.replace({ widget: new ToggleWidget(s.title, s.folded, s.foldFrom, s.foldTo) }).range(s.from, s.to)); break;
      case "table": ranges.push(Decoration.replace({ widget: new TableWidget(s.rows, s.align, s.from), block: true }).range(s.from, s.to)); break;
      case "hint": ranges.push(Decoration.widget({ widget: new HintWidget(s.text), side: 1 }).range(s.at)); break;
    }
  }
  return Decoration.set(ranges, true);
}

function build(state: EditorState, resolver: () => LinkResolver): DecorationSet {
  try { return toDecorations(previewSpecs(state, { focused: state.field(focusField), resolver: resolver() })); }
  catch { return Decoration.none; }
}

/** Toggle the task marker "[ ]" / "[x]" at pos (its "[" ). Returns the new checked state. */
export function toggleTaskAt(view: EditorView, from: number): boolean | null {
  const s = view.state.sliceDoc(from, from + 3);
  if (!/^\[[ xX]\]$/.test(s)) return null;
  const on = s[1] === " ";
  view.dispatch({ changes: { from: from + 1, to: from + 2, insert: on ? "x" : " " }, userEvent: "input.toggle" });
  return on;
}

export interface PreviewConfig {
  resolver: () => LinkResolver;
  /** Called after a checkbox is toggled, with the line's text (for [[item:...]] sync). */
  onTask?: (lineText: string, checked: boolean) => void;
  /** Open an app link (client-side navigation). */
  navigate: (href: string, newTab: boolean) => void;
}

export function livePreview(cfg: PreviewConfig): Extension {
  const field = StateField.define<DecorationSet>({
    create: (s) => build(s, cfg.resolver),
    update(deco, tr) {
      const focusChanged = tr.effects.some((e) => e.is(setFocused) || e.is(foldEffect) || e.is(unfoldEffect));
      if (tr.docChanged || tr.selection || focusChanged || tr.reconfigured || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, cfg.resolver);
      // The parser may have finished more of the document since.
      return deco.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const handlers = EditorView.domEventHandlers({
    focus(_e, view) { queueMicrotask(() => view.dispatch({ effects: setFocused.of(true) })); },
    blur(_e, view) {
      // Keep the raw line while a menu of ours (assist, completion) has the focus.
      setTimeout(() => { if (!view.hasFocus) view.dispatch({ effects: setFocused.of(false) }); }, 0);
    },
    mousedown(e, view) {
      const el = e.target as HTMLElement;
      const check = el.closest("[data-check]");
      if (check) {
        const pos = view.posAtDOM(check);
        const line = view.state.doc.lineAt(pos);
        const on = toggleTaskAt(view, pos);
        if (on !== null) cfg.onTask?.(view.state.doc.line(line.number).text, on);
        e.preventDefault();
        return true;
      }
      const toggle = el.closest<HTMLElement>("[data-toggle]");
      if (toggle) {
        const [from, to, folded] = toggle.dataset.toggle!.split(":").map(Number);
        view.dispatch({ effects: (folded ? unfoldEffect : foldEffect).of({ from, to }) });
        e.preventDefault();
        return true;
      }
      const link = el.closest<HTMLElement>("[data-href]");
      if (link && (link.classList.contains("cm-md-wiki") || e.metaKey || e.ctrlKey)) {
        const href = link.dataset.href!;
        e.preventDefault();
        if (/^https?:\/\//i.test(href)) window.open(href, "_blank", "noopener");
        else cfg.navigate(href, e.metaKey || e.ctrlKey);
        return true;
      }
      const table = el.closest<HTMLElement>("[data-table-from]");
      if (table) {
        view.dispatch({ selection: { anchor: Number(table.dataset.tableFrom) + 2 } });
        view.focus();
        e.preventDefault();
        return true;
      }
      return false;
    },
    click(e) {
      // The chip is an <a>; navigation was handled on mousedown.
      if ((e.target as HTMLElement).closest(".cm-md-wiki")) { e.preventDefault(); return true; }
      return false;
    },
  });

  return [focusField, field, handlers];
}
