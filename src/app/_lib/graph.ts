import { buildGraph, type GraphData } from "@/lib/graph/graph";
import type { User } from "@/lib/types";
import { linkSources, listPages } from "@/server/local/pages";
import { loadAll } from "./lines";

/** The whole graph for one user: items and meetings (names through the directory), notes and their links. */
export async function loadGraph(user: User, now = new Date()): Promise<GraphData> {
  const { items, meetings, people } = await loadAll(user);
  let sources: ReturnType<typeof linkSources> = [];
  let notes: ReturnType<typeof listPages> = [];
  try {
    notes = listPages();
    sources = linkSources();
  } catch {
    // No notes folder yet: people, meetings and items only.
  }
  return buildGraph({ items, meetings, people, self: [user.name, ...user.aliases], sources, notes, now, timeZone: user.timeZone });
}
