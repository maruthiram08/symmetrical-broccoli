"use client";

// "Project" in an item's actions (under "…" on a phone): put the item in a project, make a new
// project, or take it out of one.
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { projectsAction, setItemProjectAction } from "@/app/structure-actions";
import { projectLabel } from "@/lib/structure/views";


export function ProjectMenu({ itemId, project }: { itemId: string; project: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Array<{ slug: string; title: string }> | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const wrap = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    void projectsAction().then(setList).catch(() => setError("Couldn't load projects."));
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const pick = (value: string, create = false) => {
    setError(null);
    start(async () => {
      const r = await setItemProjectAction(itemId, value, { create });
      if (!r.ok) { setError(r.error); return; }
      setOpen(false);
      setName("");
      router.refresh();
    });
  };

  return (
    <span className="db-snooze st-projmenu" ref={wrap}>
      <button type="button" className="db-act" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {project ? `+${projectLabel(project)}` : "Project"}
      </button>
      {open ? (
        <div className="db-snooze__menu st-projmenu__menu" role="menu" id={id} aria-label="Project" data-menu-open="true" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setOpen(false); }}>
          {list === null ? <span className="db-snooze__loading">…</span> : list.map((p) => (
            <button key={p.slug} type="button" role="menuitemradio" aria-checked={p.slug === project} disabled={pending} onClick={() => pick(p.slug)}>
              {p.title}{p.slug === project ? <span>✓</span> : null}
            </button>
          ))}
          {project ? <button type="button" role="menuitem" disabled={pending} onClick={() => pick("")}>No project</button> : null}
          <form className="st-projmenu__new" onSubmit={(e) => { e.preventDefault(); if (name.trim()) pick(name, true); }}>
            <input className="db-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New project…" aria-label="New project name" maxLength={80} />
          </form>
          {error ? <span className="db-snooze__error" role="alert">{error}</span> : null}
        </div>
      ) : null}
    </span>
  );
}
