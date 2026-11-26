"use client";

// Settings › Templates: edit a note template and see it rendered against sample data as you type.
import { useRouter } from "next/navigation";
import { useDeferredValue, useMemo, useState, useTransition } from "react";
import { resetTemplateAction, saveTemplateAction } from "@/app/workspace-actions";
import { renderSample, TEMPLATE_INFO, type TemplateKind } from "@/lib/templates/kinds";

export function TemplateEditor({ kind, initial, custom, links }: { kind: TemplateKind; initial: string; custom: boolean; links: boolean }) {
  const router = useRouter();
  const info = TEMPLATE_INFO[kind];
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const shown = useDeferredValue(text);

  const preview = useMemo(() => {
    try {
      return { ok: true as const, md: renderSample(kind, shown, links) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "This template can't be read." };
    }
  }, [kind, shown, links]);

  const save = () => start(async () => {
    const r = await saveTemplateAction(kind, text);
    if (r.ok) { setSaved(text); setStatus({ ok: true, text: "Saved. The next note uses it." }); router.refresh(); }
    else setStatus({ ok: false, text: r.error });
  });
  const reset = () => start(async () => {
    await resetTemplateAction(kind);
    setText(info.defaults);
    setSaved(info.defaults);
    setStatus({ ok: true, text: "Back to the default." });
    router.refresh();
  });

  const dirty = text !== saved;
  return (
    <div className="tp-editor">
      <div className="tp-editor__panes">
        <label className="tp-editor__pane">
          <span className="tp-editor__label">Template <span className="db-mono">{info.file}</span>{custom || text !== info.defaults ? null : <span className="ws-list__tag">Default</span>}</span>
          <textarea className="db-input tp-editor__src db-mono" value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); setStatus(null); }}
            aria-describedby="tp-fields" rows={24} />
        </label>
        <div className="tp-editor__pane">
          <span className="tp-editor__label">Preview, with sample data</span>
          {preview.ok
            ? <pre className="tp-editor__out db-mono" aria-live="polite">{preview.md}</pre>
            : <p className="db-note db-note--error tp-editor__err" role="alert">{preview.error}</p>}
        </div>
      </div>
      <p className="db-field__hint" id="tp-fields">
        Fields: {info.fields}. Use <code>{"{{field}}"}</code>, <code>{"{{#if field}}…{{else}}…{{/if}}"}</code>, <code>{"{{#each list}}…{{/each}}"}</code> and <code>{"{{! a comment }}"}</code>. Text comes ready for Markdown.
      </p>
      <div className="db-row">
        <button type="button" className="db-btn db-btn--primary" onClick={save} disabled={pending || !dirty || !preview.ok}>{pending ? "Saving…" : "Save template"}</button>
        <button type="button" className="db-btn db-btn--ghost" onClick={reset} disabled={pending || (!custom && text === info.defaults)}>Reset to default</button>
        {status ? <span className={`tp-editor__status${status.ok ? "" : " tp-editor__status--error"}`} role="status">{status.text}</span> : null}
      </div>
    </div>
  );
}
