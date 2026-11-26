// The three note templates, their defaults, the fields each one offers, and sample data for the
// Settings preview. Pure, so the preview renders in the browser as you type.

import type { WeekModel } from "@/lib/brief/week";
import type { BriefModel, Item, Meeting } from "@/lib/types";
import { DEFAULT_DAILY_TEMPLATE, renderDaily } from "./daily";
import { linkContext, meetingNoteName } from "./links";
import { DEFAULT_MEETING_TEMPLATE, renderMeetingNote, type MeetingNoteInput } from "./meeting";
import { DEFAULT_WEEK_TEMPLATE, renderWeek } from "./week";

export const TEMPLATE_KINDS = ["daily", "week", "meeting"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export const TEMPLATE_INFO: Record<TemplateKind, { label: string; file: string; fields: string; defaults: string }> = {
  daily: {
    label: "Daily note",
    file: "YYYY-MM-DD.md",
    defaults: DEFAULT_DAILY_TEMPLATE,
    fields:
      "date, dateLabel, meetingsLine, meetingCount, nothingOwed, noMeetings, wrap.meetings/made/kept/late, openPromises, " +
      "youOwe, waitingOn, decisions, stillOpen (each: box, star, text, when, detail, person, quote, meeting, meetingTime, due, late, note), " +
      "closedToday (text, closeQuote, closedInMeeting, closedAtTime, person), stillOpenCount, stillOpenMore, tomorrowSection, wrapSection",
  },
  week: {
    label: "Weekly recap",
    file: "week-YYYY-Www.md",
    defaults: DEFAULT_WEEK_TEMPLATE,
    fields:
      "key, week, monday, sunday, label, summary, counts.meetings/made/kept/late, youOwe and oweYou (person, counts, open, closed, total), " +
      "decisions (text, quote, meeting, day, time), stale (text, ageDays, waiting, quote, meeting, day, detail), staleDays, staleCount",
  },
  meeting: {
    label: "Meeting note",
    file: "meetings/YYYY-MM-DD Title.md",
    defaults: DEFAULT_MEETING_TEMPLATE,
    fields:
      "title, titleYaml, date, time, dayLink, participants, participantList, shared, youOwe and waitingOn (box, text, when, quote, done, person), " +
      "decisions (text, quote), closed (text, closeQuote), link",
  },
};

export function isTemplateKind(k: string): k is TemplateKind {
  return (TEMPLATE_KINDS as readonly string[]).includes(k);
}

// ---------- sample data for the preview ----------

const line = (over: Partial<BriefModel["youOwe"][number]>): BriefModel["youOwe"][number] => ({
  itemId: "a1b2c3d4", kind: "owe", text: "Send Nitin the final banner text", person: "Nitin", quote: "I'll send you the banner copy by Friday",
  meetingTitle: "Growth standup", meetingTime: "10:30 AM", dueLabel: "Fri", lateMinutes: null, lateLabel: null, meetingId: "m1", ...over,
});

export const SAMPLE_BRIEF: BriefModel = {
  userId: "u", date: "2026-11-26", dateLabel: "Thursday, 26 November", meetingCount: 2,
  wrap: { meetings: 2, made: 3, kept: 1, late: 1 }, openPromises: 4,
  youOwe: [
    line({ itemId: "a1", lateMinutes: 2880, lateLabel: "2d late", dueLabel: null, text: "Share the Q4 plan with Priya", person: "Priya", quote: "I'll share the plan tonight", meetingTitle: "Planning", meetingTime: "9:00 AM", meetingId: "m2" }),
    line({ itemId: "a2", starred: true }),
    line({ itemId: "a3", text: "Book the venue", person: null, quote: "", meetingTitle: "", meetingTime: "", manual: true, note: "Ask for the terrace", dueLabel: null }),
  ],
  waitingOn: [line({ itemId: "w1", kind: "waiting", text: "Tarun to send the API spec", person: "Tarun", quote: "I'll get you the spec tomorrow", dueLabel: "Tomorrow" })],
  decisions: [line({ itemId: "d1", kind: "decision", text: "Ship the dividend banner on Friday", person: null, quote: "Let's just ship it Friday", dueLabel: null })],
  closedToday: [{ itemId: "c1", text: "Send the invoice to Meera", closeQuote: "Got the invoice, thanks", person: "Meera", closedInMeeting: "Finance sync", closedAtTime: "26 Nov" }],
  stillOpenCount: 6,
  stillOpen: [line({ itemId: "s1", text: "Review the onboarding copy", person: "Nitin", meetingTitle: "Design review, 18 Nov", meetingTime: "4:00 PM", dueLabel: null, quote: "I'll review it this week" })],
  empty: null, subject: "Your day: 1 overdue",
  tomorrow: [{
    calendarId: "c1", title: "Weekly with Priya", time: "11:00 AM", startsAt: "2026-11-27T05:30:00Z", people: ["Priya"], seriesId: null,
    owe: [{ itemId: "a1", text: "Share the Q4 plan with Priya", person: "Priya", when: "2d late", late: true }], waiting: [], alsoOpen: 0, alsoIn: [],
  }],
};

export const SAMPLE_WEEK: WeekModel = {
  key: "2026-W48", week: 48, monday: "2026-11-23", sunday: "2026-11-29", label: "Week 48, 23–29 November",
  counts: { meetings: 9, made: 7, kept: 4, late: 1 },
  youOwe: [{ person: "Nitin", total: 3, open: 2 }, { person: "Priya", total: 1, open: 1 }],
  oweYou: [{ person: "Tarun", total: 2, open: 1 }],
  decisions: [{ itemId: "d1", text: "Ship the dividend banner on Friday", quote: "Let's just ship it Friday", meetingTitle: "Growth standup", day: "Thu 26 Nov", time: "10:30 AM" }],
  stale: [{ itemId: "s1", kind: "waiting", text: "Tarun to send the pricing sheet", person: "Tarun", quote: "I'll dig it out", meetingTitle: "Pricing", day: "12 Nov", ageDays: 14 }],
};

const sampleMeeting: Meeting = {
  id: "m1", userId: "u", providerMeetingId: "p1", title: "Growth standup", startedAt: "2026-11-26T05:00:00Z",
  participants: ["Nitin", "Priya", "you@example.com"], processedAt: "2026-11-26T06:00:00Z", link: null,
};
const sampleItem = (over: Partial<Item>): Item => ({
  id: "i1", userId: "u", kind: "owe", text: "Send Nitin the final banner text", person: "Nitin", quote: "I'll send you the banner copy by Friday",
  meetingId: "m1", dueAt: "2026-11-27T12:30:00Z", status: "open", closedByMeetingId: null, closeQuote: null,
  createdAt: "2026-11-26T06:00:00Z", closedAt: null, source: "extracted", ...over,
});
export const SAMPLE_MEETING: MeetingNoteInput = {
  meeting: sampleMeeting, timeZone: "Asia/Kolkata", now: new Date("2026-11-26T12:00:00Z"),
  items: [
    sampleItem({}),
    sampleItem({ id: "i2", kind: "waiting", text: "Priya to send the launch numbers", person: "Priya", quote: "I'll send numbers after lunch", dueAt: null }),
    sampleItem({ id: "d1", kind: "decision", text: "Ship the dividend banner on Friday", person: null, quote: "Let's just ship it Friday", dueAt: null }),
  ],
  closed: [sampleItem({ id: "c1", text: "Send the deck to Nitin", status: "done", closeQuote: "Got the deck, thanks", meetingId: "m0" })],
};

const sampleLinks = linkContext({
  names: ["Nitin", "Priya", "Tarun", "Meera"],
  meetings: new Map([["m1", meetingNoteName("2026-11-26", "Growth standup")], ["m2", meetingNoteName("2026-11-26", "Planning")]]),
});

/** Render a template against the sample data. Throws TemplateError for a broken template. */
export function renderSample(kind: TemplateKind, template: string, links: boolean): string {
  const l = links ? sampleLinks : undefined;
  if (kind === "daily") return renderDaily(SAMPLE_BRIEF, { template, links: l });
  if (kind === "week") return renderWeek(SAMPLE_WEEK, { template, links: l });
  return renderMeetingNote(SAMPLE_MEETING, { template, links: l });
}
