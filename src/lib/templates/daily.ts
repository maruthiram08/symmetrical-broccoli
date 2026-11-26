// The daily note (YYYY-MM-DD.md) as a template. With the default template and no links, the output
// is exactly what renderMarkdown in src/lib/brief/markdown.ts writes (see templates.test.ts).

import { esc } from "@/lib/brief/markdown";
import { renderWrapSection } from "@/lib/brief/wrap";
import { renderTomorrowSection } from "@/lib/calendar/glance";
import { renderRoutinesSection } from "@/lib/routines/brief";
import type { BriefLine, BriefModel } from "@/lib/types";
import { renderTemplate, tidyMarkdown } from "./engine";
import { blockLink, linkMention, wikilink, type LinkContext } from "./links";

export const DEFAULT_DAILY_TEMPLATE = `---
date: {{date}}
meetings: {{wrap.meetings}}
promises_made: {{wrap.made}}
kept: {{wrap.kept}}
late: {{wrap.late}}
---

# {{dateLabel}}

{{meetingsLine}}

{{#if nothingOwed}}
**Nothing owed. Go home.**

{{/if}}
{{#if youOwe}}
## You owe

{{#each youOwe}}
{{box}} {{star}}{{text}}{{when}}
  {{detail}}
{{/each}}

{{/if}}
{{#if waitingOn}}
## Waiting on

{{#each waitingOn}}
{{box}} {{star}}{{text}}{{when}}
  {{detail}}
{{/each}}

{{/if}}
{{#if decisions}}
## Decisions

{{#each decisions}}
{{box}} {{star}}{{text}}{{when}}
  {{detail}}
{{/each}}

{{/if}}
{{routinesSection}}
{{#if closedToday}}
## Closed today

{{#each closedToday}}
- [x] ~~{{text}}~~
  Closed: "{{closeQuote}}" in {{closedInMeeting}}, {{closedAtTime}}
{{/each}}

{{/if}}
{{#if stillOpenCount}}
## Still open from before ({{stillOpenCount}})

{{#each stillOpen}}
{{box}} {{star}}{{text}}{{when}}
  {{detail}}
{{/each}}
{{#if stillOpenMore}}
- …and {{stillOpenMore}} more
{{/if}}

{{/if}}
{{tomorrowSection}}
{{wrapSection}}
`;

/** One item line, every field ready to drop into Markdown. */
export interface LineView {
  kind: string;
  /** "- [ ]" for things to do, "-" for decisions. */
  box: string;
  /** "★ " when starred, else "". */
  star: string;
  text: string;
  /** " **(2d late)**", " (Fri)" or "". */
  when: string;
  /** The line under the item: the quote and meeting, or "Added by you · …". */
  detail: string;
  person: string;
  quote: string;
  meeting: string;
  meetingTime: string;
  due: string;
  late: string;
  note: string;
  manual: boolean;
  shared: boolean;
  starred: boolean;
}

/** Everything a daily note template can use. */
export interface DailyView {
  date: string;
  dateLabel: string;
  meetingCount: number;
  meetingsLine: string;
  nothingOwed: boolean;
  noMeetings: boolean;
  wrap: BriefModel["wrap"];
  openPromises: number | string;
  youOwe: LineView[];
  waitingOn: LineView[];
  decisions: LineView[];
  closedToday: Array<{ text: string; closeQuote: string; closedInMeeting: string; closedAtTime: string; person: string }>;
  stillOpen: LineView[];
  stillOpenCount: number;
  stillOpenMore: number;
  tomorrowSection: string;
  wrapSection: string;
  /** "## Routines due today" with its lines, or "" when none are due. */
  routinesSection: string;
}

export function lineView(l: BriefLine, links?: LinkContext): LineView {
  const box = l.kind === "decision" ? "-" : "- [ ]";
  const when = l.lateLabel ? ` **(${l.lateLabel})**` : l.dueLabel ? ` (${l.dueLabel})` : "";
  let text = esc(l.text);
  let person = l.person ? esc(l.person) : "";
  let meeting = esc(l.meetingTitle);
  let extra = "";
  if (links) {
    const target = links.person(l.person);
    if (target && l.person) {
      const r = linkMention(text, esc(l.person), target, l.person);
      text = r.text;
      person = wikilink(target, l.person);
      // Not named in the text: name them under it, so the person's page still gets the backlink.
      if (!r.linked && !l.manual) extra += ` · ${person}`;
    }
    const note = links.meeting(l.meetingId);
    if (note) meeting = wikilink(note, l.meetingTitle);
    if (l.kind === "decision") extra += ` · ${blockLink("decisions", links.decision(l.itemId), "decision log")}`;
  }
  const detail = l.manual
    ? `Added by you${person ? ` · ${person}` : ""}${l.note ? ` · ${esc(l.note)}` : ""}${extra}`
    : `"${esc(l.quote)}" · ${meeting}, ${l.meetingTime}${l.shared ? " · shared" : ""}${extra}`;
  return {
    kind: l.kind, box, star: l.starred ? "★ " : "", text, when, detail, person,
    quote: esc(l.quote), meeting, meetingTime: l.meetingTime, due: l.dueLabel ?? "", late: l.lateLabel ?? "",
    note: l.note ? esc(l.note) : "", manual: !!l.manual, shared: !!l.shared, starred: !!l.starred,
  };
}

export function dailyView(m: BriefModel, links?: LinkContext): DailyView {
  const lv = (l: BriefLine) => lineView(l, links);
  return {
    date: m.date,
    dateLabel: m.dateLabel,
    meetingCount: m.meetingCount,
    meetingsLine: m.meetingCount ? `From ${m.meetingCount} meeting${m.meetingCount === 1 ? "" : "s"} today.` : "No meetings today.",
    nothingOwed: m.empty === "nothing_owed",
    noMeetings: m.empty === "no_meetings",
    wrap: m.wrap,
    openPromises: m.openPromises ?? "",
    youOwe: m.youOwe.map(lv),
    waitingOn: m.waitingOn.map(lv),
    decisions: m.decisions.map(lv),
    closedToday: m.closedToday.map((c) => {
      const target = links?.person(c.person);
      return {
        text: esc(c.text), closeQuote: esc(c.closeQuote), closedInMeeting: esc(c.closedInMeeting), closedAtTime: c.closedAtTime,
        person: c.person ? (target ? wikilink(target, c.person) : esc(c.person)) : "",
      };
    }),
    stillOpen: m.stillOpenCount ? m.stillOpen.map(lv) : [],
    stillOpenCount: m.stillOpenCount,
    stillOpenMore: Math.max(0, m.stillOpenCount - m.stillOpen.length),
    tomorrowSection: renderTomorrowSection(m.tomorrow).join("\n"),
    wrapSection: renderWrapSection(m.wrap, m.openPromises).join("\n"),
    routinesSection: renderRoutinesSection(m.routines).join("\n"),
  };
}

/** The daily note from a template (the default when none is given), with links when given a context. */
export function renderDaily(m: BriefModel, opts: { template?: string | null; links?: LinkContext } = {}): string {
  return tidyMarkdown(renderTemplate(opts.template ?? DEFAULT_DAILY_TEMPLATE, dailyView(m, opts.links)));
}

/** decisions.md lines for this brief, with a ^block id and links when given a context. */
export function renderDecisionsLines(m: BriefModel, links?: LinkContext): string {
  if (!links) return m.decisions.map((d) => `- ${m.date} · ${esc(d.text)} — "${esc(d.quote)}" (${esc(d.meetingTitle)}, ${d.meetingTime})`).join("\n") + (m.decisions.length ? "\n" : "");
  return m.decisions.map((d) => {
    const v = lineView(d, links);
    const meeting = links.meeting(d.meetingId);
    return `- ${wikilink(m.date)} · ${v.text} — "${esc(d.quote)}" (${meeting ? wikilink(meeting, d.meetingTitle) : esc(d.meetingTitle)}, ${d.meetingTime}) ^${links.decision(d.itemId)}`;
  }).join("\n") + (m.decisions.length ? "\n" : "");
}
