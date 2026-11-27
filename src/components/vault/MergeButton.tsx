"use client";

// "Merge" on a note in the reading pane: opens the merge dialog, goes to the merged note after,
// and offers Undo for a while. MergeHint, in the rail, points at a likely duplicate.
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { undoMergeAction } from "@/app/vault-actions";
import type { MergeDone } from "@/server/local/merge";
import { MergeDialog } from "./MergeDialog";

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "");
const hrefOf = (p: string) => (/^notes\/[^/]+\.md$/i.test(p) ? `/notes/${encodeURIComponent(p.slice(6, -3))}` : `/notes/${p.split("/").map(encodeURIComponent).join("/")}`);

const OPEN_EVENT = "db:merge-open";

/** A rail card pointing at a likely duplicate; it opens the Merge button's dialog. */
export function MergeHint({ path }: { path: string }) {
  return (
    <div className="db-merge-hint">
      <p>Looks like the same notes as <strong>{nameOf(path)}</strong>.</p>
      <button type="button" className="rp-btn" onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}>Merge them…</button>
    </div>
  );
}

export function MergeButton({ path, files }: { path: string; files: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  useEffect(() => { const on = () => setOpen(true); window.addEventListener(OPEN_EVENT, on); return () => window.removeEventListener(OPEN_EVENT, on); }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), toast.undo ? 12000 : 6000); return () => clearTimeout(t); }, [toast]);

  const onMerged = (d: MergeDone) => {
    setOpen(false);
    router.push(hrefOf(d.target));
    router.refresh();
    const n = d.sources.length;
    setToast({
      text: `Merged ${n === 1 ? nameOf(d.sources[0]) : `${n} notes`} into ${nameOf(d.target)}`,
      undo: () => {
        void undoMergeAction(d.id).then((r) => {
          if (!r.ok) { setToast({ text: r.error }); return; }
          router.refresh();
          setToast({ text: r.kept.length ? `Put back, except ${r.kept.map(nameOf).join(", ")} (changed since)` : "Put back as it was" });
        });
      },
    });
  };

  return (
    <>
      <button type="button" className="rp-btn" title="Fold other notes into this one" onClick={() => setOpen(true)}>Merge</button>
      {open ? <MergeDialog path={path} files={files} onClose={() => setOpen(false)} onMerged={onMerged} /> : null}
      {toast ? (
        <div className="db-vault__toast" role="status">
          <span>{toast.text}</span>
          {toast.undo ? <button type="button" className="db-act" onClick={() => { const u = toast.undo; setToast(null); u?.(); }}>Undo</button> : null}
        </div>
      ) : null}
    </>
  );
}
