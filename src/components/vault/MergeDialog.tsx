"use client";

// Merge notes: pick the notes to fold into the one that stays, see the result and what else changes,
// then merge. Likely duplicates (a second copy of the same meeting) are listed first.
import { useEffect, useMemo, useRef, useState } from "react";
import { mergeCandidatesAction, mergeNotesAction, mergePreviewAction } from "@/app/vault-actions";
import type { MergeDone, MergePreview } from "@/server/local/merge";

const DAY = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/;
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function MergeDialog({ path, files, onClose, onMerged }: {
  path: string;
  files: string[];
  onClose: () => void;
  onMerged: (done: MergeDone) => void;
}) {
  const [keep, setKeep] = useState(path);
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [similar, setSimilar] = useState<Array<{ path: string; score: number }>>([]);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void mergeCandidatesAction(path).then((c) => { if (!live) return; setSimilar(c); if (c[0] && c[0].score >= 0.5) setPicked((p) => (p.length ? p : [c[0].path])); });
    return () => { live = false; };
  }, [path]);

  // The preview follows what is picked.
  useEffect(() => {
    setPreview(null);
    setError(null);
    if (!picked.length) return;
    let live = true;
    const t = setTimeout(() => {
      void mergePreviewAction(keep, picked).then((r) => { if (!live) return; if (r.ok) setPreview(r.preview); else setError(r.error); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [keep, picked]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    box.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const all = useMemo(() => [path, ...picked], [path, picked]);
  const rows = useMemo(() => {
    const want = q.trim().toLowerCase();
    const sim = new Map(similar.map((s) => [s.path, s.score]));
    return files
      .filter((f) => f !== path && !DAY.test(f) && (!want || f.toLowerCase().includes(want)))
      .sort((a, b) => (sim.get(b) ?? 0) - (sim.get(a) ?? 0) || Number(!picked.includes(b)) - Number(!picked.includes(a)) || nameOf(a).localeCompare(nameOf(b)))
      .slice(0, 40)
      .map((f) => ({ path: f, similar: sim.has(f) }));
  }, [files, path, q, similar, picked]);

  const toggle = (f: string) => setPicked((p) => {
    if (p.includes(f)) { if (keep === f) setKeep(path); return p.filter((x) => x !== f); }
    return [...p, f];
  });
  const sources = all.filter((p) => p !== keep);

  const merge = async () => {
    if (!sources.length) return;
    setBusy(true);
    const r = await mergeNotesAction(keep, sources).catch(() => ({ ok: false as const, error: "Couldn't merge." }));
    setBusy(false);
    if (r.ok) onMerged(r.done);
    else setError(r.error);
  };

  return (
    <div className="db-palette-scrim db-merge-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="db-merge" role="dialog" aria-modal="true" aria-labelledby="db-merge-title" ref={box}>
        <header className="db-merge__head">
          <h2 id="db-merge-title">Merge notes</h2>
          <p className="db-merge__lede">Pick notes to fold into one. Their text goes in under “From …”, links to them point at the one you keep, and they move to .trash. You can undo it.</p>
        </header>
        <div className="db-merge__cols">
          <section className="db-merge__pick" aria-label="Notes to merge">
            <input className="db-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a note" aria-label="Find a note" />
            <ul className="db-merge__list">
              {rows.map((r) => (
                <li key={r.path}>
                  <label className="db-merge__row">
                    <input type="checkbox" checked={picked.includes(r.path)} onChange={() => toggle(r.path)} />
                    <span className="db-merge__name">{nameOf(r.path)}</span>
                    {r.similar ? <span className="db-merge__tag">Looks similar</span> : null}
                    {folderOf(r.path) ? <span className="db-merge__folder">{folderOf(r.path)}</span> : null}
                  </label>
                </li>
              ))}
              {!rows.length ? <li className="db-merge__none">No other notes match.</li> : null}
            </ul>
          </section>
          <section className="db-merge__result" aria-label="Result" aria-live="polite">
            <div className="db-merge__keep">
              <span className="db-merge__label">Keep</span>
              <div className="db-merge__chips" role="radiogroup" aria-label="Note to keep">
                {all.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={keep === p} className="db-merge__chip" onClick={() => setKeep(p)}>{nameOf(p)}</button>
                ))}
              </div>
            </div>
            {!picked.length ? <p className="db-merge__empty">Tick a note on the left to see the merged note here.</p> : null}
            {error ? <p className="db-merge__error" role="alert">{error}</p> : null}
            {preview ? (
              <>
                <ul className="db-merge__facts">
                  <li>Adds {plural(preview.added, "line")} from {sources.map(nameOf).join(", ")}</li>
                  {preview.skipped ? <li>Leaves out {plural(preview.skipped, "line")} already in the note, like the same to-do twice</li> : null}
                  {preview.relinked.length ? <li>Points {plural(preview.relinked.reduce((n, r) => n + r.count, 0), "link")} in {preview.relinked.slice(0, 3).map((r) => nameOf(r.path)).join(", ")}{preview.relinked.length > 3 ? ` and ${preview.relinked.length - 3} more` : ""} at {nameOf(keep)}</li> : null}
                  {preview.emptySources.length ? <li>{preview.emptySources.join(", ")} has nothing new and just moves to .trash</li> : null}
                  {preview.conflicts.map((c) => <li key={`${c.key}:${c.from}`} className="db-merge__clash">Keeps {c.key}: {c.kept || "(empty)"}, not {c.dropped} from {c.from}</li>)}
                </ul>
                <pre className="db-merge__preview" tabIndex={0} aria-label={`${nameOf(keep)} after merging`}>{preview.markdown}</pre>
              </>
            ) : picked.length && !error ? <p className="db-merge__empty">Putting it together…</p> : null}
          </section>
        </div>
        <footer className="db-merge__foot">
          <button type="button" className="db-act" onClick={onClose}>Cancel</button>
          <button type="button" className="db-btn db-btn--primary" disabled={!preview || busy} onClick={() => void merge()}>
            {busy ? "Merging…" : sources.length ? `Merge ${plural(sources.length, "note")} into ${nameOf(keep)}` : "Merge"}
          </button>
        </footer>
      </div>
    </div>
  );
}
