"use client";

// Projects' list: your projects, then threads found in your meetings (suggestions, never filed).
// Picking one shows it on the right.
import Link from "next/link";
import { useReading } from "./Pane";

export interface ProjectRow {
  /** The selection id: a project slug, or "thread:<id>" for a found thread. */
  slug: string;
  title: string;
  line: string;
  last: string;
  /** "Stalled since 16 Nov" in red instead of the last meeting. */
  lastLate?: boolean;
  open: number;
  found?: boolean;
}
export interface ProjectRowGroup { key: string; label: string; rows: ProjectRow[]; empty?: string }

export function ProjectList({ rows, groups, foot }: { rows?: ProjectRow[]; groups?: ProjectRowGroup[]; foot?: string }) {
  const r = useReading();
  const gs = groups ?? [{ key: "projects", label: "Most active first", rows: rows ?? [] }];
  const total = gs.reduce((n, g) => n + g.rows.length, 0);
  return (
    <div className="rp-scroll" data-rp-list="">
      {gs.map((g) => (
        <section key={g.key} aria-label={g.label}>
          <h2 className="rp-gh" id={`rp-g-${g.key}`}>{g.label}<span className="rp-gh__n">{g.rows.length}</span></h2>
          {g.rows.length ? null : g.empty ? <p className="rp-empty">{g.empty}</p> : null}
          {g.rows.map((p) => {
            const sel = r?.selected === p.slug;
            return (
              <div key={p.slug} className={`rp-prow${sel ? " rp-row--sel" : ""}`} data-rp-row={p.slug} aria-current={sel ? "true" : undefined}>
                <span className={`rp-m rp-m--${p.found ? "ring" : "proj"}`} aria-hidden="true" />
                <div className="rp-prow__body">
                  <Link className="rp-prow__nm" href={`/projects?project=${encodeURIComponent(p.slug)}`} scroll={false}
                    onClick={(e) => { if (r && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); r.select(p.slug); } }}>
                    {p.title}
                  </Link>
                  <div className="rp-prow__st">{p.line}</div>
                  {p.last ? <div className={`rp-prow__ls${p.lastLate ? " rp-prow__ls--late" : ""}`}>{p.lastLate ? p.last : `Last: ${p.last}`}</div> : null}
                </div>
                <div className="rp-prow__num">{p.open}<small>open</small></div>
              </div>
            );
          })}
        </section>
      ))}
      {total ? null : <p className="rp-empty">No projects yet. Make one from a topic under Filing, or with ⋯ › Move to project on any item.</p>}
      {foot ? <div className="rp-lfoot">{foot}</div> : null}
    </div>
  );
}
