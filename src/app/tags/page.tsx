import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { tagHref } from "@/lib/structure/tag-core";
import type { TagNode } from "@/lib/structure/tags";
import { me } from "@/server/local/app";
import { openCountFor, pastDays } from "../_lib/days";
import { loadStructure } from "../_lib/structure";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tags" };

const counts = (n: TagNode) => [n.notes ? `${n.notes} note${n.notes === 1 ? "" : "s"}` : "", n.items ? `${n.items} item${n.items === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");

function Tree({ nodes, depth = 0 }: { nodes: TagNode[]; depth?: number }) {
  return (
    <ul className={depth ? "st-tree st-tree--sub" : "st-tree"}>
      {nodes.map((n) => (
        <li key={n.tag}>
          <Link className="st-tree__row" href={tagHref(n.tag)}>
            <span className="st-tree__name"><span className="st-tree__hash" aria-hidden="true">#</span>{depth ? n.name : n.tag}</span>
            <span className="st-tree__n">{counts(n)}</span>
          </Link>
          {n.children.length ? <Tree nodes={n.children} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

// Every tag in notes and on items, as a tree: #project/launch sits under #project.
export default async function Tags() {
  const user = await me();
  if (!user) redirect("/setup");
  const s = await loadStructure(user);
  return (
    <Shell days={await pastDays(user.id, "")} current="tags" openCount={await openCountFor(user.id)}>
      <h1 className="db-title">Tags</h1>
      <p className="db-subtitle">
        Type <span className="db-mono">#tag</span> or <span className="db-mono">#nested/tag</span> in a note, a <span className="db-mono">tags:</span> property, or <span className="db-mono">#tag</span> in quick capture. Counts include tags nested under each one.
      </p>
      {s.tree.length ? <Tree nodes={s.tree} /> : <p className="db-section__empty">No tags yet.</p>}
    </Shell>
  );
}
