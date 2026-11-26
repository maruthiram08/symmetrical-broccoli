"use client";

// Projects' list: one row per project, most active first. Picking one shows it on the right.
import Link from "next/link";
import { useReading } from "./Pane";

export interface ProjectRow { slug: string; title: string; line: string; last: string; open: number }

export function ProjectList({ rows }: { rows: ProjectRow[] }) {
  const r = useReading();
  return (
    <div className="rp-scroll" data-rp-list="">
      <h2 className="rp-gh">Most active first<span className="rp-gh__n">{rows.length}</span></h2>
      {rows.map((p) => {
        const sel = r?.selected === p.slug;
        return (
          <div key={p.slug} className={`rp-prow${sel ? " rp-row--sel" : ""}`} data-rp-row={p.slug} aria-current={sel ? "true" : undefined}>
            <span className="rp-m rp-m--proj" aria-hidden="true" />
            <div className="rp-prow__body">
              <Link className="rp-prow__nm" href={`/projects?project=${encodeURIComponent(p.slug)}`} scroll={false}
                onClick={(e) => { if (r && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); r.select(p.slug); } }}>
                {p.title}
              </Link>
              <div className="rp-prow__st">{p.line}</div>
              {p.last ? <div className="rp-prow__ls">Last: {p.last}</div> : null}
            </div>
            <div className="rp-prow__num">{p.open}<small>open</small></div>
          </div>
        );
      })}
      {rows.length ? null : <p className="rp-empty">No projects yet. Make one from a topic under Filing, or with ⋯ › Move to project on any item.</p>}
    </div>
  );
}
