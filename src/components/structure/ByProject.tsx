import Link from "next/link";
import { BriefItem } from "@/components/BriefList";
import type { BriefLine } from "@/lib/types";
import { noteRows } from "@/server/structure/notes";

/** Lines grouped under their project (projects by title, then the rest under "No project"). */
export function groupByProject(lines: BriefLine[], title: (slug: string) => string): Array<{ slug: string | null; title: string; lines: BriefLine[] }> {
  const groups = new Map<string, BriefLine[]>();
  for (const l of lines) groups.set(l.project ?? "", [...(groups.get(l.project ?? "") ?? []), l]);
  return [...groups.entries()]
    .map(([slug, ls]) => ({ slug: slug || null, title: slug ? title(slug) : "No project", lines: ls }))
    .sort((a, b) => (a.slug === null ? 1 : b.slug === null ? -1 : a.title.localeCompare(b.title)));
}

/** The brief's lines, under one heading per project. */
export function ByProject({ lines, back }: { lines: BriefLine[]; back?: string }) {
  let titles = new Map<string, string>();
  try { titles = new Map(noteRows().map((n) => [n.slug, n.title])); } catch { /* notes folder unreadable: show slugs */ }
  return (
    <>
      {groupByProject(lines, (s) => titles.get(s) ?? s.replace(/-/g, " ")).map((g) => (
        <div key={g.slug ?? "_none"} className="db-group">
          <h3 className="db-group__title">
            {g.slug ? <Link className="st-group-link" href={`/notes/${encodeURIComponent(g.slug)}`}>{g.title}</Link> : g.title} <span className="db-section__count">{g.lines.length}</span>
          </h3>
          {g.lines.map((l) => <BriefItem key={l.itemId} line={l} back={back} />)}
        </div>
      ))}
    </>
  );
}

/** "Group by project" on Today, shown once any item has a project. */
export function GroupToggle({ on, any }: { on: boolean; any: boolean }) {
  if (!any && !on) return null;
  return <>{" · "}<Link className="db-link" href={on ? "/" : "/?group=project"}>{on ? "Ungroup" : "Group by project"}</Link></>;
}
