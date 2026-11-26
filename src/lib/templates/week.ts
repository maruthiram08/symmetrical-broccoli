// The weekly recap (week-YYYY-Www.md) as a template. The default reproduces renderWeekMarkdown.

import { esc } from "@/lib/brief/markdown";
import { STALE_DAYS, type PersonCount, type WeekModel } from "@/lib/brief/week";
import { renderTemplate, tidyMarkdown } from "./engine";
import { blockLink, linkMention, wikilink, type LinkContext } from "./links";

export const DEFAULT_WEEK_TEMPLATE = `---
week: {{key}}
from: {{monday}}
to: {{sunday}}
meetings: {{counts.meetings}}
promises_made: {{counts.made}}
kept: {{counts.kept}}
late: {{counts.late}}
---

# {{label}}

{{summary}}

{{#if youOwe}}
## People you owe

{{#each youOwe}}
- {{person}}: {{counts}}
{{/each}}

{{/if}}
{{#if oweYou}}
## People who owe you

{{#each oweYou}}
- {{person}}: {{counts}}
{{/each}}

{{/if}}
{{#if decisions}}
## Decisions

{{#each decisions}}
- {{text}}
  "{{quote}}" · {{meeting}}, {{day}}, {{time}}
{{/each}}

{{/if}}
{{#if stale}}
## Open more than {{staleDays}} days ({{staleCount}})

{{#each stale}}
- [ ] {{text}} ({{ageDays}}d){{waiting}}
  {{detail}}
{{/each}}

{{/if}}
`;

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

export function weekView(w: WeekModel, links?: LinkContext) {
  const person = (raw: string) => {
    const t = links?.person(raw);
    return t ? wikilink(t, raw) : esc(raw);
  };
  const people = (ps: PersonCount[]) => ps.map((p) => ({
    person: person(p.person), open: p.open, closed: p.total - p.open, total: p.total,
    counts: [p.open ? `${p.open} open` : "", p.total > p.open ? `${p.total - p.open} closed` : ""].filter(Boolean).join(", "),
  }));
  return {
    key: w.key, week: w.week, monday: w.monday, sunday: w.sunday, label: w.label, counts: w.counts,
    summary: `${plural(w.counts.made, "promise")} made, ${w.counts.kept} kept, ${w.counts.late} late. From ${plural(w.counts.meetings, "meeting")}.`,
    youOwe: people(w.youOwe),
    oweYou: people(w.oweYou),
    decisions: w.decisions.map((d) => ({
      text: links ? `${esc(d.text)} · ${blockLink("decisions", links.decision(d.itemId), "decision log")}` : esc(d.text),
      quote: esc(d.quote), meeting: esc(d.meetingTitle), day: d.day, time: d.time,
    })),
    stale: w.stale.map((s) => {
      let text = esc(s.text);
      const t = links?.person(s.person);
      if (t && s.person) text = linkMention(text, esc(s.person), t, s.person).text;
      return {
        text, ageDays: s.ageDays, waiting: s.kind === "waiting" ? " · waiting" : "", kind: s.kind,
        quote: s.quote ? esc(s.quote) : "", meeting: esc(s.meetingTitle), day: s.day,
        detail: `${s.quote ? `"${esc(s.quote)}" · ` : ""}${esc(s.meetingTitle)}, ${s.day}`,
      };
    }),
    staleDays: STALE_DAYS,
    staleCount: w.stale.length,
  };
}

export function renderWeek(w: WeekModel, opts: { template?: string | null; links?: LinkContext } = {}): string {
  return tidyMarkdown(renderTemplate(opts.template ?? DEFAULT_WEEK_TEMPLATE, weekView(w, opts.links)));
}
