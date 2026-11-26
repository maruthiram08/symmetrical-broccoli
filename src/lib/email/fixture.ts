// Sample day (IST) used by the renderer tests and the /dev/email preview.
import type { BriefModel } from "@/lib/types";
import type { EmailLinks } from "./render";

export const fixtureBrief: BriefModel = {
  userId: "user-fixture",
  date: "2026-11-25",
  dateLabel: "Wednesday, 25 November",
  meetingCount: 4,
  wrap: { meetings: 4, made: 4, kept: 1, late: 1 },
  youOwe: [
    {
      itemId: "item-banner",
      kind: "owe",
      text: "Send Nitin the final banner text",
      person: "Nitin",
      quote: "I'll send it in half an hour",
      meetingTitle: "Dividend banner",
      meetingTime: "1:51 PM",
      dueLabel: "Today",
      lateMinutes: 240,
      lateLabel: "4h late",
    },
    {
      itemId: "item-ui-notes",
      kind: "owe",
      text: "Share dividend UI notes with Prajwal",
      person: "Prajwal",
      quote: "I'll put my notes in the thread tonight",
      meetingTitle: "Dividend implementation",
      meetingTime: "4:35 PM",
      dueLabel: "Today",
      lateMinutes: null,
      lateLabel: null,
    },
  ],
  waitingOn: [
    {
      itemId: "item-ca-config",
      kind: "waiting",
      text: "Tarun to confirm the corporate actions config",
      person: "Tarun",
      quote: "Let me check with the data team and come back",
      meetingTitle: "Corporate actions",
      meetingTime: "6:10 PM",
      dueLabel: "Tomorrow",
      lateMinutes: null,
      lateLabel: null,
    },
  ],
  decisions: [
    {
      itemId: "item-record-date",
      kind: "decision",
      text: "Dividend banner shows only for stocks with a record date in the next 7 days",
      person: null,
      quote: "Let's only show it when the record date is inside a week",
      meetingTitle: "Dividend banner",
      meetingTime: "1:51 PM",
      dueLabel: null,
      lateMinutes: null,
      lateLabel: null,
    },
  ],
  closedToday: [
    {
      itemId: "item-timeline",
      text: "Tarun to check the release timeline",
      closeQuote: "timeline is fine for Friday",
      person: "Tarun",
      closedInMeeting: "Dividend implementation",
      closedAtTime: "4:35 PM",
    },
  ],
  stillOpenCount: 0,
  stillOpen: [],
  empty: null,
  subject: "You owe 2, 1 late · Wednesday, 25 November",
};

export const fixtureLinks: EmailLinks = {
  base: "https://brief.example.com",
  actionUrl: (itemId, action) => `https://brief.example.com/a/${itemId}.${action}`,
  downloadUrl: "https://brief.example.com/a/download-token",
  deleteUrl: "https://brief.example.com/a/delete-token",
};

/** Variants for the preview page and tests. */
export function fixtureVariant(variant: "full" | "nothing_owed" | "no_meetings" | "still_open"): BriefModel {
  const base = structuredClone(fixtureBrief);
  switch (variant) {
    case "full":
      return base;
    case "nothing_owed":
      return { ...base, youOwe: [], wrap: { ...base.wrap, late: 0 }, empty: "nothing_owed", subject: "Nothing owed · Wednesday, 25 November" };
    case "no_meetings":
      return {
        ...base,
        meetingCount: 0,
        wrap: { meetings: 0, made: 0, kept: 0, late: 0 },
        youOwe: [],
        waitingOn: [],
        decisions: [],
        closedToday: [],
        stillOpenCount: 3,
        stillOpen: [
          { ...base.youOwe[1], itemId: "old-1", meetingTime: "Mon, 4:35 PM", dueLabel: null, lateMinutes: null, lateLabel: null },
          { ...base.waitingOn[0], itemId: "old-2", meetingTime: "Tue, 6:10 PM", dueLabel: "Fri" },
          { ...base.youOwe[0], itemId: "old-3", meetingTime: "Tue, 1:51 PM", lateMinutes: 2880, lateLabel: "2d late" },
        ],
        empty: "no_meetings",
        subject: "No meetings today · 3 items still open",
      };
    case "still_open":
      return {
        ...base,
        stillOpenCount: 7,
        stillOpen: Array.from({ length: 5 }, (_, n) => ({ ...base.waitingOn[0], itemId: `old-${n}`, text: `Tarun to send the old report ${n + 1}`, meetingTime: "Mon, 11:00 AM", dueLabel: null })),
      };
  }
}

/** The local app's links: "Open" goes to the item's page on this Mac. */
export const localLinks: EmailLinks = {
  base: "http://localhost:4242",
  itemUrl: (itemId) => `http://localhost:4242/item/${itemId}`,
};
