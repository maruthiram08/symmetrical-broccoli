"use client";

// The editor's code (CodeMirror and its Markdown support) loads after the page, so pages with a
// note open as fast as the rest of the app. Until then, the note shows as plain text.
import dynamic from "next/dynamic";
import type { MarkdownEditorProps } from "./MarkdownEditor";

const Editor = dynamic(() => import("./MarkdownEditor").then((m) => m.MarkdownEditor), { ssr: false });

export function LazyEditor(p: MarkdownEditorProps) {
  return (
    <div className="db-ed-lazy">
      <Editor {...p} />
    </div>
  );
}
