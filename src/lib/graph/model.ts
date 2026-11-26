// The graph's shape and its filters. No imports, so the page's client code stays small.

export const NODE_TYPES = ["person", "meeting", "promise", "decision", "note"] as const;
export type GraphNodeType = (typeof NODE_TYPES)[number];

export const NODE_LABELS: Record<GraphNodeType, string> = { person: "People", meeting: "Meetings", promise: "Promises", decision: "Decisions", note: "Notes" };

export interface GraphNode {
  /** "person:<slug>", "meeting:<id>", "item:<id>", "note:<slug>", "day:<date>". */
  id: string;
  type: GraphNodeType;
  label: string;
  href: string;
  /** When it happened, ISO (meetings, items: their meeting; notes: last change; days: the day). Null for people. */
  date: string | null;
  /** Promises and decisions: still open. Others: true. */
  open: boolean;
  /** Promises: "owe" (you owe them) or "waiting" (they owe you). */
  kind?: "owe" | "waiting";
  overdue?: boolean;
  /** One line for the hover preview: who, when, where from. */
  sub?: string;
  /** A longer line for the preview: a quote, a note's first line. */
  detail?: string;
}

/** owes: you owe this person (item -> person). owed: they owe you. from: item -> its meeting. met: person -> meeting. link: a [[link]] (source -> target). */
export type GraphEdgeType = "owes" | "owed" | "from" | "met" | "link";

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------- filtering ----------

export interface GraphFilter {
  types?: GraphNodeType[];
  /** A person node id: only what is within two steps of them. */
  person?: string | null;
  /** Leave out done promises and closed decisions (and meetings left with nothing). */
  openOnly?: boolean;
  /** ISO bounds on node dates; nodes without a date (people) always pass. */
  from?: string | null;
  to?: string | null;
}

/** Nodes within `hops` steps of `center`, BFS order (center first), at most `max`. */
export function neighborhood(g: GraphData, center: string, hops = 2, max = Infinity): GraphData {
  if (!g.nodes.some((n) => n.id === center)) return { nodes: [], edges: [] };
  const adj = adjacency(g);
  const keep = new Set([center]);
  let frontier = [center];
  for (let h = 0; h < hops && frontier.length && keep.size < max; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (keep.has(nb)) continue;
        if (keep.size >= max) break;
        keep.add(nb);
        next.push(nb);
      }
    }
    frontier = next;
  }
  return subgraph(g, keep);
}

function adjacency(g: GraphData): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    (adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target);
    (adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source);
  }
  return adj;
}

function subgraph(g: GraphData, keep: Set<string>): GraphData {
  return { nodes: g.nodes.filter((n) => keep.has(n.id)), edges: g.edges.filter((e) => keep.has(e.source) && keep.has(e.target)) };
}

export function filterGraph(g: GraphData, f: GraphFilter): GraphData {
  const types = new Set(f.types?.length ? f.types : NODE_TYPES);
  const from = f.from ? Date.parse(f.from) : -Infinity;
  const to = f.to ? Date.parse(f.to) : Infinity;
  let keep = new Set(
    g.nodes
      .filter((n) => types.has(n.type) || n.id === f.person)
      .filter((n) => !f.openOnly || n.open)
      .filter((n) => !n.date || (Date.parse(n.date) >= from && Date.parse(n.date) <= to))
      .map((n) => n.id),
  );
  let out = subgraph(g, keep);
  if (f.openOnly) {
    // A meeting is worth showing only while something open came from it (or a note links it).
    const linked = new Set(out.edges.filter((e) => e.type === "from" || e.type === "link").flatMap((e) => [e.source, e.target]));
    keep = new Set(out.nodes.filter((n) => n.type !== "meeting" || linked.has(n.id)).map((n) => n.id));
    out = subgraph(out, keep);
  }
  if (f.person) out = neighborhood(out, f.person, 2);
  // People with nothing left around them are noise; notes stay even when nothing links them.
  const deg = new Set(out.edges.flatMap((e) => [e.source, e.target]));
  return subgraph(out, new Set(out.nodes.filter((n) => n.type === "note" || n.id === f.person || deg.has(n.id)).map((n) => n.id)));
}

/** Time range presets for the filter, as ISO lower bounds. */
export const RANGES = { "7d": 7, "30d": 30, "90d": 90, "365d": 365, all: null } as const;
export type RangeId = keyof typeof RANGES;
export function rangeFrom(r: RangeId, now: Date): string | null {
  const d = RANGES[r];
  return d === null ? null : new Date(now.getTime() - d * 86400000).toISOString();
}
