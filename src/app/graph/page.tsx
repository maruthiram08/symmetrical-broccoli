import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { GraphView, type GraphViewState } from "@/components/graph/GraphView";
import { NODE_TYPES, RANGES, type GraphNodeType, type RangeId } from "@/lib/graph/graph";
import { me } from "@/server/local/app";
import { loadGraph } from "../_lib/graph";
import { openCountFor, pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Graph" };

type Search = { types?: string; person?: string; open?: string; range?: string; focus?: string };

// Everyone, every meeting, open promise, decision and note, and how they connect.
export default async function Graph({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const q = await searchParams;
  const now = new Date();
  const data = await loadGraph(user, now);
  const types = (q.types ?? "").split(",").filter((t): t is GraphNodeType => (NODE_TYPES as readonly string[]).includes(t));
  const focus = q.focus && data.nodes.some((n) => n.id === q.focus) ? q.focus : null;
  const personId = q.person ? `person:${q.person}` : focus?.startsWith("person:") ? focus : null;
  const initial: GraphViewState = {
    types: types.length ? types : [...NODE_TYPES],
    person: personId && data.nodes.some((n) => n.id === personId) ? personId : null,
    // Following a link to something closed shows closed things too.
    open: q.open === "0" ? false : focus && data.nodes.find((n) => n.id === focus)?.open === false ? false : true,
    range: q.range && q.range in RANGES ? (q.range as RangeId) : "all",
  };
  return (
    <Shell days={await pastDays(user.id, "")} current="graph" openCount={await openCountFor(user.id)} wide>
      <h1 className="db-title">Graph</h1>
      <p className="db-subtitle">Who owes whom, which meeting each promise came from, and how your notes link. Click anything to open it.</p>
      {data.nodes.length ? (
        <GraphView data={data} initial={initial} focus={focus && !focus.startsWith("person:") ? focus : null} now={now.toISOString()} />
      ) : (
        <p className="gr-empty">Nothing to draw yet. Once meetings are read, people, promises and decisions show here.</p>
      )}
    </Shell>
  );
}
