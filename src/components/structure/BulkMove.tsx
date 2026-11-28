"use client";

// "Select" on a group of items (a project, Needs a project, Filed automatically): tick some or
// all, then move them into another project or out of any. Each move counts as your own filing.
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { moveItemsToProjectAction, projectsAction, removeProjectAction } from "@/app/structure-actions";

export interface BulkRow { id: string; text: string; meta?: string }

export function BulkMove({ rows, current, children }: { rows: BulkRow[]; current?: string | null; children: React.ReactNode }) {
  const router = useRouter();
  const [on, setOn] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [list, setList] = useState<Array<{ slug: string; title: string }> | null>(null);
  const [to, setTo] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => { if (on && list === null) void projectsAction().then(setList).catch(() => setList([])); }, [on, list]);

  if (!rows.length) return <>{children}</>;
  const all = picked.size === rows.length;
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const move = () => start(async () => {
    setNote(null);
    const r = await moveItemsToProjectAction([...picked], to);
    if (!r.ok) { setNote(r.error); return; }
    const where = to ? list?.find((p) => p.slug === to)?.title ?? to : "no project";
    setNote(`Moved ${r.moved} to ${where}.`);
    setPicked(new Set());
    setOn(false);
    router.refresh();
  });

  return (
    <div className="pf-bulk">
      <div className="pf-bulk__bar">
        <button type="button" className="db-act" onClick={() => { setOn((o) => !o); setPicked(new Set()); setNote(null); }}>{on ? "Cancel" : "Select"}</button>
        {on ? (
          <>
            <label className="pf-bulk__all"><input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.id)))} /> All {rows.length}</label>
            <select className="db-input pf-bulk__to" aria-label="Move to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">No project</option>
              {(list ?? []).filter((p) => p.slug !== current).map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
            </select>
            <button type="button" className="db-act" disabled={pending || !picked.size} onClick={move}>
              {pending ? "Moving…" : `Move ${picked.size || ""}`.trim()}
            </button>
          </>
        ) : null}
        {note ? <span className="st-list__meta" role="status">{note}</span> : null}
      </div>
      {on ? (
        <ul className="st-list pf-bulk__list">
          {rows.map((r) => (
            <li key={r.id}>
              <label className="st-list__row pf-bulk__row">
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} />
                <span>{r.text}</span>
                {r.meta ? <span className="st-list__meta">{r.meta}</span> : null}
              </label>
            </li>
          ))}
        </ul>
      ) : children}
    </div>
  );
}

/** "Remove project" on a project: its items go back to Needs a project and the note is archived. */
export function RemoveProjectButton({ slug, title, count }: { slug: string; title: string; count: number }) {
  const router = useRouter();
  const [sure, setSure] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (!sure) return <button type="button" className="db-act pf-remove" onClick={(e) => { e.preventDefault(); setSure(true); }}>Remove project</button>;
  return (
    <span className="pf-remove">
      <span className="st-list__meta">Take {count ? `its ${count} item${count === 1 ? "" : "s"} out and ` : ""}archive {title}?</span>
      <button type="button" className="db-act" disabled={pending} onClick={(e) => { e.preventDefault(); start(async () => {
        const r = await removeProjectAction(slug);
        if (!r.ok) { setError(r.error); return; }
        router.refresh();
      }); }}>{pending ? "Removing…" : "Remove"}</button>
      <button type="button" className="db-act" onClick={(e) => { e.preventDefault(); setSure(false); }}>Keep</button>
      {error ? <span className="db-snooze__error" role="alert">{error}</span> : null}
    </span>
  );
}
