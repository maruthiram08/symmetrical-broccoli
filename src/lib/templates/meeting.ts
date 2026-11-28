// Meeting notes (meetings/<date> <title>.md) and person pages (people/<Name>.md): the pages the
// [[links]] in daily notes point at. Pure: the caller passes the items.

import { esc } from "@/lib/brief/markdown";
import { formatTime, localDate } from "@/lib/brief/time";
import type { Item, Meeting } from "@/lib/types";
import { renderTemplate, tidyMarkdown } from "./engine";
import { blockLink, linkMention, meetingNoteName, wikilink, type LinkContext } from "./links";

export const DEFAULT_MEETING_TEMPLATE = `---
meeting: {{titleYaml}}
date: {{date}}
time: {{time}}
---

# {{title}}

{{dayLink}}, {{time}}{{#if participants}} · with {{participantList}}{{/if}}{{#if shared}} · shared{{/if}}

{{#if youOwe}}
## You owe

{{#each youOwe}}
{{box}} {{text}}{{when}}
  "{{quote}}"
{{/each}}

{{/if}}
{{#if waitingOn}}
## Waiting on

{{#each waitingOn}}
{{box}} {{text}}{{when}}
  "{{quote}}"
{{/each}}

{{/if}}
{{#if decisions}}
## Decisions

{{#each decisions}}
- {{text}}
  "{{quote}}"
{{/each}}

{{/if}}
{{#if closed}}
## Closed here

{{#each closed}}
- [x] ~~{{text}}~~
  "{{closeQuote}}"
{{/each}}

{{/if}}
{{#if link}}
[Open in Wispr Flow]({{link}})
{{/if}}
`;

export interface MeetingNoteInput {
  meeting: Meeting;
  /** Items read from this meeting. */
  items: Item[];
  /** Items from earlier meetings that this meeting closed. */
  closed: Item[];
  timeZone: string;
  now: Date;
}

const itemText = (i: Item, links?: LinkContext) => {
  let text = esc(i.text);
  const t = links?.person(i.person);
  if (t && i.person) {
    const r = linkMention(text, esc(i.person), t, i.person);
    text = r.linked ? r.text : `${text} · ${wikilink(t, i.person)}`;
  }
  return text;
};

const dueText = (i: Item, now: Date, timeZone: string) => {
  if (i.status !== "open" || !i.dueAt) return "";
  const day = localDate(new Date(i.dueAt), timeZone);
  return Date.parse(i.dueAt) < now.getTime() ? ` **(due ${day})**` : ` (due ${day})`;
};

export function meetingView(input: MeetingNoteInput, links?: LinkContext) {
  const { meeting: m, timeZone, now } = input;
  const date = localDate(new Date(m.startedAt), timeZone);
  const live = input.items.filter((i) => i.status !== "wrong");
  const row = (i: Item) => ({
    box: i.status === "done" ? "- [x]" : "- [ ]", text: itemText(i, links), when: dueText(i, now, timeZone),
    quote: esc(i.quote), done: i.status === "done", person: i.person ? esc(i.person) : "",
  });
  const people = m.participants.filter((p) => !p.includes("@")).map((p) => {
    const t = links?.person(p);
    return t ? wikilink(t, p) : esc(p);
  });
  return {
    title: esc(m.title), titleYaml: JSON.stringify(m.title), date, time: formatTime(m.startedAt, timeZone),
    dayLink: links ? wikilink(date) : date,
    participants: people, participantList: people.join(", "), shared: !!m.shared,
    youOwe: live.filter((i) => i.kind === "owe").map(row),
    waitingOn: live.filter((i) => i.kind === "waiting").map(row),
    decisions: live.filter((i) => i.kind === "decision").map((i) => ({
      text: links ? `${itemText(i, links)} · ${blockLink("decisions", links.decision(i.id), "decision log")}` : esc(i.text), quote: esc(i.quote),
    })),
    closed: input.closed.map((i) => ({ text: itemText(i, links), closeQuote: esc(i.closeQuote ?? "") })),
    link: m.link && /^https:\/\//.test(m.link) ? m.link.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20") : "",
  };
}

export function renderMeetingNote(input: MeetingNoteInput, opts: { template?: string | null; links?: LinkContext } = {}): string {
  return tidyMarkdown(renderTemplate(opts.template ?? DEFAULT_MEETING_TEMPLATE, meetingView(input, opts.links)));
}

export const meetingNoteFile = (m: Meeting, timeZone: string) => `${meetingNoteName(localDate(new Date(m.startedAt), timeZone), m.title)}.md`;

/** people/<Name>.md: what's open with one person, and where it came from. Not templated. */
export function renderPersonPage(input: {
  name: string;
  items: Item[];
  meetings: Map<string, Meeting>;
  timeZone: string;
  now: Date;
  links: LinkContext;
}): string {
  const { name, items, meetings, timeZone, now, links } = input;
  const from = (i: Item) => {
    const m = meetings.get(i.meetingId);
    if (!m) return i.source === "manual" ? "added by you" : "a meeting";
    const note = links.meeting(m.id);
    return note ? wikilink(note, `${m.title}, ${localDate(new Date(m.startedAt), timeZone)}`) : `${esc(m.title)}, ${localDate(new Date(m.startedAt), timeZone)}`;
  };
  const row = (i: Item) => [`- [${i.status === "done" ? "x" : " "}] ${esc(i.text)}${dueText(i, now, timeZone)}`, `  ${i.quote ? `"${esc(i.quote)}" · ` : ""}${from(i)}`];
  const out = ["---", `person: ${JSON.stringify(name)}`, "---", "", `# ${esc(name)}`, ""];
  const open = (kind: Item["kind"]) => items.filter((i) => i.kind === kind && i.status === "open");
  const owe = open("owe"), waiting = open("waiting");
  out.push(`${owe.length} you owe, ${waiting.length} waiting on ${esc(name)}.`, "");
  if (owe.length) out.push(`## You owe ${esc(name)}`, "", ...owe.flatMap(row), "");
  if (waiting.length) out.push(`## Waiting on ${esc(name)}`, "", ...waiting.flatMap(row), "");
  const closed = items.filter((i) => i.kind !== "decision" && i.status === "done").sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")).slice(0, 10);
  if (closed.length) out.push("## Recently closed", "", ...closed.flatMap(row), "");
  const met = [...new Set(items.map((i) => i.meetingId))].map((id) => meetings.get(id)).filter((m): m is Meeting => !!m)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  if (met.length) out.push("## Meetings", "", ...met.map((m) => `- ${links.meeting(m.id) ? wikilink(links.meeting(m.id)!, m.title) : esc(m.title)} · ${wikilink(localDate(new Date(m.startedAt), timeZone))}`), "");
  return tidyMarkdown(out.join("\n"));
}
