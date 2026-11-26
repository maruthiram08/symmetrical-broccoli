// ⌘K rows for tags, saved views and "New note of type…". Pure, so it is tested without a browser.
import { fold, terms } from "@/lib/search";
import { tagHref } from "./tag-core";

export interface PaletteData {
  tags: Array<{ tag: string; count: number }>;
  views: Array<{ id: string; name: string; source: "notes" | "items" }>;
  types: Array<{ id: string; name: string }>;
}

export interface PaletteRow {
  id: string;
  group: string;
  label: string;
  sub?: string;
  href?: string;
  /** A note type to make a note of, with this title ("" lets the server name it). */
  create?: { typeId: string; title: string };
  hl?: boolean;
}

const has = (label: string, ws: string[]) => { const hay = fold(label); return ws.every((w) => hay.includes(" " + w)); };

export function paletteRows(d: PaletteData, q: string): PaletteRow[] {
  const query = q.trim();
  const ws = terms(query);
  const out: PaletteRow[] = [];
  // Views.
  for (const v of d.views.filter((v) => !ws.length || has(`${v.name} view`, ws)).slice(0, ws.length ? 4 : 5)) {
    out.push({ id: `view-${v.id}`, group: "Views", label: v.name, sub: v.source === "items" ? "Items" : "Notes", href: `/views/${encodeURIComponent(v.id)}`, hl: true });
  }
  // Tags: "#lau" or "lau" finds #launch and #launch/web.
  const t = query.replace(/^#/, "").toLowerCase();
  const tags = !query ? d.tags.slice(0, 4) : d.tags.filter((x) => x.tag.includes(t) || x.tag.split("/").some((p) => p.startsWith(t)) || (ws.length > 0 && has(x.tag.replace(/\//g, " "), ws)));
  for (const x of tags.slice(0, query.startsWith("#") ? 8 : 4)) {
    out.push({ id: `tag-${x.tag}`, group: "Tags", label: `#${x.tag}`, sub: `${x.count}`, href: tagHref(x.tag), hl: true });
  }
  // New note of type…: "new project Q4 launch" names it.
  const m = query.match(/^new\s+(.*)$/i);
  for (const type of d.types) {
    const name = type.name.toLowerCase();
    if (m) {
      const rest = m[1];
      const words = name.split(/\s+/);
      // "new project Q4" / "new meeting note standup" / "new meet".
      let title: string | null = null;
      const lower = rest.toLowerCase();
      if (lower.startsWith(name + " ")) title = rest.slice(name.length + 1).trim();
      else if (lower.startsWith(words[0] + " ") && words.length > 1 && !words.slice(1).some((w) => lower.split(/\s+/).includes(w))) title = rest.slice(words[0].length + 1).trim();
      else if (lower === name || name.startsWith(lower) || words.some((w) => w.startsWith(lower))) title = "";
      if (title === null) continue;
      out.push({ id: `new-${type.id}`, group: "New note", label: title ? `New ${name} “${title}”` : `New ${name}…`, create: { typeId: type.id, title } });
    } else if (!ws.length || has(`new ${type.name} note`, ws)) {
      out.push({ id: `new-${type.id}`, group: "New note", label: `New ${name}…`, sub: "From its template", create: { typeId: type.id, title: "" } });
    }
  }
  return out;
}
