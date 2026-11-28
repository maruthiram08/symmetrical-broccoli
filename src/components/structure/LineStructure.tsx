import Link from "next/link";
import { tagHref } from "@/lib/structure/tag-core";
import { projectLabel } from "@/lib/structure/views";

/** An item's project and tags on its line: "· +q4 launch #api". */
export function LineStructure({ tags, project, auto }: { tags?: string[]; project?: string | null; auto?: string }) {
  if (!tags?.length && !project) return null;
  return (
    <span className="db-item__src st-line">
      {project ? <Link className={auto ? "st-proj st-proj--auto" : "st-proj"} href={`/notes/${encodeURIComponent(project)}`} title={auto ? `Filed automatically: ${auto}. Change it under Project.` : undefined}>+{projectLabel(project)}</Link> : null}
      {tags?.map((t) => <Link key={t} className="st-tag st-tag--quiet" href={tagHref(t)}>#{t}</Link>)}
    </span>
  );
}
