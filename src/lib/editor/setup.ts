// The notes editor's CodeMirror state: Markdown (GFM + [[links]]), history, keys, menus and the
// live preview. The document is the Markdown text, kept exactly, including its line endings.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, keymap, placeholder as placeholderExt, type KeyBinding } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { formattingKeymap, lineCommandKeymap, linkSource, slashSource, type LineCommandHandler, type LinkTarget } from "./commands";
import { lineSeparatorOf, NoteSyntax } from "./markdown";
import { focusMode } from "./focus";
import { livePreview, type PreviewConfig } from "./preview";

const highlight = HighlightStyle.define([
  { tag: tags.processingInstruction, class: "cm-md-markup" },
  { tag: tags.meta, class: "cm-md-markup" },
  { tag: tags.url, class: "cm-md-url" },
  { tag: tags.monospace, class: "cm-md-mono" },
  { tag: tags.quote, class: "cm-md-quotetext" },
]);

/** The note as Markdown, with the file's own line endings (doc.toString() would always use "\n"). */
export const docText = (s: EditorState) => s.sliceDoc();

/** The parts that don't need a browser: language, line endings, history. Used by tests too. */
export function baseExtensions(doc: string): Extension[] {
  return [
    EditorState.lineSeparator.of(lineSeparatorOf(doc)),
    markdown({ base: markdownLanguage, extensions: NoteSyntax, addKeymap: false, completeHTMLTags: false }),
    indentUnit.of("  "),
    EditorState.allowMultipleSelections.of(true),
  ];
}

export interface EditorOptions {
  placeholder?: string;
  targets: () => LinkTarget[];
  newNote?: (title: string) => Promise<string | null>;
  today: () => string;
  lineCommands: LineCommandHandler;
  preview: PreviewConfig;
  keys?: KeyBinding[];
  onChange?: (doc: string) => void;
  onSelection?: (view: EditorView) => void;
}

export function editorExtensions(doc: string, o: EditorOptions): Extension[] {
  return [
    ...baseExtensions(doc),
    history(),
    drawSelection(),
    closeBrackets(),
    codeFolding({ placeholderDOM: () => { const s = document.createElement("span"); s.className = "cm-md-foldgap"; return s; } }),
    syntaxHighlighting(highlight),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", "aria-multiline": "true", role: "textbox" }),
    o.placeholder ? placeholderExt(o.placeholder) : [],
    autocompletion({ override: [slashSource(o.today), linkSource(o.targets, o.newNote)], icons: false, defaultKeymap: true, closeOnBlur: true, activateOnTyping: true, aboveCursor: false }),
    lineCommandKeymap(o.lineCommands),
    formattingKeymap(o.keys),
    keymap.of([
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...markdownKeymap,
      { key: "Tab", run: indentMore, shift: indentLess },
      ...historyKeymap,
      ...defaultKeymap,
    ]),
    livePreview(o.preview),
    focusMode(),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) o.onChange?.(docText(u.state));
      if (u.selectionSet || u.focusChanged || u.docChanged) o.onSelection?.(u.view);
    }),
  ];
}
