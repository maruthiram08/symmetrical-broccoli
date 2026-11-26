// The graph: people, meetings, open promises, decisions and notes, and how they connect (who owes
// whom, which meeting an item came from, who was in a meeting, [[links]] between notes, which are
// also the backlinks). Pure: the page loads items, meetings, the directory and notes and passes them in.
// Names go through the people directory (items arrive resolved; links and participants are matched
// with the same rules as People), and speaker labels ("Speaker 5") are never people.
import { findWikiLinks, noteSlug, type LinkSource } from "@/lib/editor/links";
import { groupNames, ownsItem, personSlug, type PersonGroup } from "@/lib/people";
import { linkIsPerson } from "@/lib/directory/match";
import { isSpeakerLabel } from "@/lib/directory/speakers";
import type { Person } from "@/lib/directory/directory";
import type { Item, Meeting } from "@/lib/types";
import type { GraphData, GraphEdge, GraphEdgeType, GraphNode } from "./model";

export * from "./model";

export interface GraphInput {
  items: Item[];
  meetings: Meeting[];
  /** The people directory's people. */
  people: Person[];
  /** The user's own name and aliases: never a person node. */
  self: string[];
  /** Notes and daily notes (their [[links]]), from linkSources(). */
  sources: LinkSource[];
  /** Every note page, with its last change, so notes without links still show. */
  notes: Array<{ slug: string; title: string; updatedAt: string }>;
  now: Date;
  timeZone: string;
}

const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });

/** A Markdown note's first line of text, for the preview. */
function firstLine(md: string): string {
  for (const raw of md.split(/\r?\n/)) {
    const l = raw.replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/, "").replace(/\[\[(?:[a-z]+:)?([^|\]]+)(?:\|([^\]]+))?\]\]/g, (_m, t, l2) => l2 ?? t).replace(/[*_`~]+/g, "").trim();
    if (l && !/^---$/.test(l) && !/^<!--/.test(l)) return l.slice(0, 140);
  }
  return "";
}

export function buildGraph(input: GraphInput): GraphData {
  const { items, meetings, people, self, sources, notes, now, timeZone } = input;
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  const edge = (source: string, target: string, type: GraphEdgeType) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const k = type === "link" ? `${source}>${target}` : `${source}|${target}|${type}`;
    if (seenEdge.has(k)) return;
    seenEdge.add(k);
    edges.push({ source, target, type });
  };

  const live = items.filter((i) => i.status === "open" || i.status === "done");
  const groups = groupNames(live.map((i) => i.person ?? "").filter(Boolean), self, people);
  const selfKeys = new Set(self.map((s) => s.toLowerCase().trim()));
  const personId = (g: PersonGroup) => `person:${g.slug}`;
  for (const g of groups) {
    if (!g.slug) continue;
    nodes.set(personId(g), { id: personId(g), type: "person", label: g.name, href: `/people/${encodeURIComponent(g.slug)}`, date: null, open: true });
  }
  /** The person group a free name (participant, link) means, through the directory. */
  const groupFor = (name: string): PersonGroup | null => {
    if (!name || isSpeakerLabel(name) || selfKeys.has(name.toLowerCase().trim())) return null;
    return groups.find((g) => linkIsPerson(g, name, people)) ?? null;
  };

  const meetingById = new Map<string, Meeting>();
  for (const m of meetings) {
    if (m.duplicateOf) continue;
    meetingById.set(m.id, m);
    const who = m.participants.filter((p) => !isSpeakerLabel(p) && !selfKeys.has(p.toLowerCase().trim()));
    nodes.set(`meeting:${m.id}`, {
      id: `meeting:${m.id}`, type: "meeting", label: m.title || "Meeting", href: `/meeting/${encodeURIComponent(m.id)}`,
      date: m.startedAt, open: true, sub: `${day(m.startedAt, timeZone)}${who.length ? ` · ${who.slice(0, 4).join(", ")}${who.length > 4 ? ` +${who.length - 4}` : ""}` : ""}`,
    });
  }

  for (const i of live) {
    const m = meetingById.get(i.meetingId);
    const when = m?.startedAt ?? i.createdAt;
    const id = `item:${i.id}`;
    const overdue = i.status === "open" && i.kind !== "decision" && !!i.dueAt && Date.parse(i.dueAt) < now.getTime();
    const who = i.person && !i.unattributed ? i.person : null;
    const sub = i.kind === "decision"
      ? `Decision${m ? ` · ${m.title}` : ""} · ${day(when, timeZone)}`
      : `${i.kind === "owe" ? `You owe${who ? ` ${who}` : ""}` : `${who ?? "Someone"} owes you`}${i.dueAt ? ` · due ${day(i.dueAt, timeZone)}` : ""}${i.status === "done" ? " · done" : ""}`;
    nodes.set(id, {
      id, type: i.kind === "decision" ? "decision" : "promise", label: i.text, href: `/item/${encodeURIComponent(i.id)}`,
      date: when, open: i.status === "open", ...(i.kind !== "decision" ? { kind: i.kind } : {}), ...(overdue ? { overdue } : {}),
      sub, ...(i.quote ? { detail: `“${i.quote.slice(0, 160)}”` } : {}),
    });
    if (m) edge(id, `meeting:${m.id}`, "from");
    if (i.kind !== "decision" && who) {
      const g = groups.find((x) => ownsItem(x, i));
      if (g) edge(id, personId(g), i.kind === "owe" ? "owes" : "owed");
    }
  }

  // Who was in each meeting (only people who also show elsewhere: People lists names from items).
  for (const m of meetingById.values()) {
    for (const p of m.participants) {
      const g = groupFor(p);
      if (g) edge(personId(g), `meeting:${m.id}`, "met");
    }
  }

  // Notes and daily notes, then their [[links]].
  const noteList = notes.map((n) => ({ slug: n.slug, title: n.title }));
  const srcBy = new Map(sources.map((s) => [`${s.type}:${s.id}`, s]));
  for (const n of notes) {
    const s = srcBy.get(`note:${n.slug}`);
    nodes.set(`note:${n.slug}`, { id: `note:${n.slug}`, type: "note", label: n.title, href: `/notes/${encodeURIComponent(n.slug)}`, date: n.updatedAt, open: true, sub: `Note · ${day(n.updatedAt, timeZone)}`, ...(s ? { detail: firstLine(s.markdown.replace(/^\s*#\s.*\n/, "")) } : {}) });
  }
  const dayNode = (date: string, md?: string) => {
    const id = `day:${date}`;
    if (!nodes.has(id)) nodes.set(id, { id, type: "note", label: day(`${date}T12:00:00Z`, "UTC"), href: `/day/${date}`, date: `${date}T12:00:00.000Z`, open: true, sub: "Daily note", ...(md ? { detail: firstLine(md) } : {}) });
    return id;
  };
  for (const s of sources) if (s.type === "day" && /^\d{4}-\d{2}-\d{2}$/.test(s.id)) dayNode(s.id, s.markdown);

  for (const s of sources) {
    const from = s.type === "day" ? `day:${s.id}` : `note:${s.id}`;
    if (!nodes.has(from)) continue;
    for (const l of findWikiLinks(s.markdown)) {
      let to: string | null = null;
      const asNote = () => {
        const slug = noteSlug(l.target);
        const n = noteList.find((x) => x.slug === slug || x.title.toLowerCase() === l.target.toLowerCase());
        return n ? `note:${n.slug}` : null;
      };
      const asPerson = () => {
        if (isSpeakerLabel(l.target)) return null;
        const g = groupFor(l.target);
        if (g) return personId(g);
        // A linked name nobody has yet: its page offers to add them.
        const slug = personSlug(l.target);
        if (!slug || selfKeys.has(l.target.toLowerCase().trim())) return null;
        const id = `person:${slug}`;
        if (!nodes.has(id)) nodes.set(id, { id, type: "person", label: l.target.trim(), href: `/people/${encodeURIComponent(slug)}`, date: null, open: true, sub: "Not in People yet" });
        return id;
      };
      switch (l.kind) {
        case "note": to = asNote(); break;
        case "person": to = asPerson(); break;
        case "item": to = nodes.has(`item:${l.target}`) ? `item:${l.target}` : null; break;
        case "meeting": to = nodes.has(`meeting:${l.target}`) ? `meeting:${l.target}` : null; break;
        case "day": to = /^\d{4}-\d{2}-\d{2}$/.test(l.target) ? dayNode(l.target) : null; break;
        default: to = asNote() ?? asPerson();
      }
      if (to) edge(from, to, "link");
    }
  }

  // People only from links or items that all went away are still nodes; drop people with nothing at all.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const out = [...nodes.values()].filter((n) => n.type !== "person" || degree.get(n.id));
  return { nodes: out, edges };
}

