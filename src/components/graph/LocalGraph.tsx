import Link from "next/link";
import { neighborhood } from "@/lib/graph/graph";
import type { User } from "@/lib/types";
import { loadGraph } from "@/app/_lib/graph";
import { GraphCanvas } from "./GraphCanvas";

/** A small graph on a person, note or meeting page: what is one or two steps away. */
export async function LocalGraph({ user, center, hops = 2 }: { user: User; center: string; hops?: 1 | 2 }) {
  let local;
  try {
    local = neighborhood(await loadGraph(user), center, hops, 90);
  } catch {
    return null;
  }
  if (local.nodes.length < 2) return null;
  return (
    <section className="db-section gr-local" aria-labelledby="gr-local-title">
      <div className="db-section__head">
        <h2 className="db-section__title" id="gr-local-title">Connections</h2>
        <span className="db-section__count">{local.nodes.length - 1}</span>
        <Link className="db-link gr-local__all" href={`/graph?focus=${encodeURIComponent(center)}`}>Open graph</Link>
      </div>
      <GraphCanvas data={local} height={280} focus={center} compact label={`${local.nodes.length - 1} things connected to this page`} />
    </section>
  );
}
