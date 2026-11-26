// One channel-neutral shape for everything a channel sends: the daily brief, the evening wrap and the
// Friday recap. Slack, Telegram, WhatsApp and the plain email for wrap/recap render from it, so the
// same item carries the same number everywhere ("/done 3" on Telegram means item 3 in the brief).
import type { BriefLine, BriefModel } from "@/lib/types";
import type { WeekModel } from "@/lib/brief/week";
import type { WrapModel } from "@/lib/brief/wrap";

export type DigestKind = "brief" | "wrap" | "week";

export interface DigestLine {
  /** Set on open items you can close by number. */
  n?: number;
  itemId?: string;
  text: string;
  /** Bolded in the text where it appears. */
  person?: string | null;
  /** "4h late", "Tomorrow", "Kept", "3 open". */
  side?: string | null;
  late?: boolean;
  done?: boolean;
  quote?: string | null;
  /** "Dividend banner, 1:51 PM". */
  source?: string | null;
}

export interface DigestSection {
  title: string;
  /** "2 open" */
  count: string;
  lines: DigestLine[];
  /** "And 2 more." */
  more?: string;
}

export interface Digest {
  kind: DigestKind;
  date: string;
  subject: string;
  title: string;
  /** One line for a notification, a preheader or a WhatsApp template. No newlines. */
  summary: string;
  /** "4 meetings · 4 promises made · 1 kept · 1 late", or null. */
  stats: string | null;
  /** "Nothing owed. Go home." and the like. */
  big: string | null;
  sections: DigestSection[];
  /** Item ids in number order: numbers[0] is item 1. */
  numbers: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const src = (title: string | null | undefined, time: string | null | undefined) => [title, time].filter(Boolean).join(", ") || null;

export function briefSummary(m: BriefModel): string {
  if (m.empty === "no_meetings") return `No meetings today. ${plural(m.youOwe.length + m.waitingOn.length + m.stillOpenCount, "item")} still open.`;
  const parts: string[] = [];
  const late = m.youOwe.filter((l) => l.lateLabel).length;
  if (m.youOwe.length) parts.push(`You owe ${m.youOwe.length}${late ? ` (${late} late)` : ""}`);
  if (m.waitingOn.length) parts.push(`waiting on ${m.waitingOn.length}`);
  if (m.decisions.length) parts.push(plural(m.decisions.length, "decision"));
  if (m.closedToday.length) parts.push(`${m.closedToday.length} closed`);
  if (!parts.length) return "Nothing owed. Go home.";
  const s = parts.join(", ");
  return `${s[0].toUpperCase()}${s.slice(1)}.`;
}

export function briefDigest(m: BriefModel): Digest {
  const numbers: string[] = [];
  const open = (l: BriefLine, withQuote = true): DigestLine => {
    numbers.push(l.itemId);
    return {
      n: numbers.length, itemId: l.itemId, text: l.text, person: l.person,
      side: l.lateLabel ?? l.dueLabel, late: !!l.lateLabel,
      quote: withQuote ? l.quote || null : null, source: src(l.meetingTitle, l.meetingTime),
    };
  };
  const sections: DigestSection[] = [];
  if (m.youOwe.length) sections.push({ title: "You owe", count: `${m.youOwe.length} open`, lines: m.youOwe.map((l) => open(l)) });
  if (m.waitingOn.length) sections.push({ title: "Waiting on", count: `${m.waitingOn.length} open`, lines: m.waitingOn.map((l) => open(l)) });
  if (m.decisions.length) {
    sections.push({
      title: "Decisions", count: `${m.decisions.length} today`,
      lines: m.decisions.map((l) => ({ itemId: l.itemId, text: l.text, person: l.person, quote: l.quote || null, source: src(l.meetingTitle, l.meetingTime) })),
    });
  }
  if (m.closedToday.length) {
    sections.push({
      title: "Closed today", count: `${m.closedToday.length} closed`,
      lines: m.closedToday.map((c) => ({ itemId: c.itemId, text: c.text, done: true, quote: c.closeQuote || null, source: src(c.closedInMeeting, c.closedAtTime) })),
    });
  }
  if (m.stillOpenCount > 0) {
    const shown = m.stillOpen.slice(0, 5);
    const more = m.stillOpenCount - shown.length;
    sections.push({
      title: "Still open from before", count: plural(m.stillOpenCount, "item"),
      lines: shown.map((l) => open(l, false)),
      more: more > 0 ? `And ${more} more. Your notes have the full list.` : undefined,
    });
  }
  const w = m.wrap;
  return {
    kind: "brief", date: m.date, subject: m.subject, title: m.dateLabel, summary: briefSummary(m),
    stats: m.empty === "no_meetings" ? null : `${plural(w.meetings, "meeting")} · ${plural(w.made, "promise")} made · ${w.kept} kept · ${w.late} late`,
    big: m.empty === "nothing_owed" ? "Nothing owed. Go home." : m.empty === "no_meetings" ? briefSummary(m) : null,
    sections, numbers,
  };
}

export function wrapDigest(w: WrapModel): Digest {
  const c = w.counts;
  const stats = `${plural(c.meetings, "meeting")} · ${plural(c.made, "promise")} made · ${c.kept} kept · ${c.late} late · ${c.open} open`;
  const sections: DigestSection[] = [];
  if (w.promises.length) {
    sections.push({
      title: "Promises today", count: `${w.promises.length} made`,
      lines: w.promises.map((p) => ({
        itemId: p.itemId, text: p.text, person: p.person, side: p.label, late: p.state === "late", done: p.state === "kept",
        quote: p.quote || null, source: src(p.meetingTitle, p.meetingTime),
      })),
    });
  }
  if (w.closes.length) {
    sections.push({
      title: "Closed today", count: `${w.closes.length} closed`,
      lines: w.closes.map((x) => ({ itemId: x.itemId, text: x.text, done: true, quote: x.closeQuote, source: x.closedInMeeting ? src(x.closedInMeeting, x.closedAtTime) : `By you, ${x.closedAtTime}` })),
    });
  }
  const summary = w.empty ? "Nothing owed. Go home." : `${plural(c.made, "promise")} made, ${c.kept} kept, ${c.late} late, ${c.open} open.`;
  return {
    kind: "wrap", date: w.date, subject: `Wrap · ${w.dateLabel}`, title: `Wrap · ${w.dateLabel}`, summary, stats,
    big: w.empty ? "Nothing owed. Go home." : null, sections, numbers: [],
  };
}

export function weekDigest(w: WeekModel): Digest {
  const c = w.counts;
  const people = (ps: WeekModel["youOwe"]): DigestLine[] =>
    ps.map((p) => ({ text: p.person, side: [p.open ? `${p.open} open` : "", p.total > p.open ? `${p.total - p.open} closed` : ""].filter(Boolean).join(", ") || null }));
  const sections: DigestSection[] = [];
  if (w.youOwe.length) sections.push({ title: "People you owe", count: plural(w.youOwe.length, "person", "people"), lines: people(w.youOwe) });
  if (w.oweYou.length) sections.push({ title: "People who owe you", count: plural(w.oweYou.length, "person", "people"), lines: people(w.oweYou) });
  if (w.decisions.length) {
    sections.push({
      title: "Decisions", count: `${w.decisions.length} this week`,
      lines: w.decisions.map((d) => ({ itemId: d.itemId, text: d.text, quote: d.quote || null, source: `${d.meetingTitle}, ${d.day}, ${d.time}` })),
    });
  }
  if (w.stale.length) {
    sections.push({
      title: "Going stale", count: `${w.stale.length} open`,
      lines: w.stale.map((s) => ({ itemId: s.itemId, text: s.text, person: s.person, side: `${s.ageDays}d`, quote: s.quote || null, source: `${s.meetingTitle}, ${s.day}` })),
    });
  }
  const summary = `${plural(c.made, "promise")} made, ${c.kept} kept, ${c.late} late. From ${plural(c.meetings, "meeting")}.`;
  return {
    kind: "week", date: w.sunday, subject: `Your week · ${w.label}`, title: w.label, summary,
    stats: `${plural(c.meetings, "meeting")} · ${plural(c.made, "promise")} made · ${c.kept} kept · ${c.late} late`,
    big: null, sections, numbers: [],
  };
}

/** Plain text, for email's text part and anything without formatting. */
export function digestText(d: Digest, link?: string): string {
  const out: string[] = [d.title];
  if (d.stats) out.push(d.stats);
  if (d.big) out.push("", d.big);
  for (const s of d.sections) {
    out.push("", `${s.title} (${s.count})`, "");
    for (const l of s.lines) {
      out.push(`${l.n ? `${l.n}. ` : "- "}${l.done ? "[closed] " : ""}${l.text}${l.side ? ` (${l.side})` : ""}`);
      const q = [l.quote ? `"${l.quote}"` : "", l.source ?? ""].filter(Boolean).join(" · ");
      if (q) out.push(`   ${q}`);
    }
    if (s.more) out.push("", s.more);
  }
  if (link) out.push("", "--", `Open Daily brief: ${link}`);
  return `${out.join("\n")}\n`;
}

/** Find the person's name (full, else first name) in text as a whole word. */
export function findName(text: string, person: string | null | undefined): { start: number; end: number } | null {
  if (!person) return null;
  const candidates = [person.trim(), person.trim().split(/\s+/)[0]].filter(Boolean);
  for (const name of candidates) {
    const lower = text.toLowerCase();
    const needle = name.toLowerCase();
    let from = 0;
    while (from <= lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx < 0) break;
      const before = idx === 0 ? "" : text[idx - 1];
      const after = text[idx + name.length] ?? "";
      if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return { start: idx, end: idx + name.length };
      from = idx + 1;
    }
  }
  return null;
}
