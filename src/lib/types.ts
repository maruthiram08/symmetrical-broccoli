// Shared domain types. Every module imports from here; keep it the single source of truth.

export type ItemKind = "owe" | "waiting" | "decision";
export type ItemStatus = "open" | "done" | "wrong";

export interface User {
  id: string;
  email: string;
  name: string;
  /** Other names the user is called in meetings ("Maruthi", "Maru", "MR"). */
  aliases: string[];
  /** IANA time zone, e.g. "Asia/Kolkata". */
  timeZone: string;
  /** Local brief time "HH:MM", 15-minute steps. Default "18:00". */
  briefTime: string;
  createdAt: string;
}

export interface Connection {
  userId: string;
  provider: "wispr_flow";
  accessToken: string; // stored encrypted, decrypted in memory only
  refreshToken: string;
  expiresAt: string;
  /** Start time (ISO) of the newest meeting already queued. */
  lastSeenAt: string | null;
  status: "active" | "needs_reconnect";
}

export interface Meeting {
  id: string;
  userId: string;
  providerMeetingId: string;
  title: string;
  startedAt: string; // ISO UTC
  participants: string[];
  processedAt: string | null;
  /** The meeting's notes page in Wispr Flow (search_meetings share_link). Missing on older meetings. */
  link?: string | null;
}

/** A calendar event coming up soon, from Wispr Flow's list_upcoming_meetings. Cached by the poll. */
export interface UpcomingMeeting {
  calendarId: string;
  title: string;
  startsAt: string; // ISO UTC
  /** Attendee names (or email addresses when no name is given). */
  attendees: string[];
}

export interface UpcomingCache {
  fetchedAt: string;
  meetings: UpcomingMeeting[];
}

export interface Item {
  id: string;
  userId: string;
  kind: ItemKind;
  /** Verb-first text: "Send Nitin the final banner text". */
  text: string;
  /** The other person involved (owner for waiting, asker for owe). Null for decisions. */
  person: string | null;
  /** Verbatim quote from the transcript, max 200 chars. */
  quote: string;
  meetingId: string;
  dueAt: string | null; // ISO UTC
  status: ItemStatus;
  closedByMeetingId: string | null;
  closeQuote: string | null;
  createdAt: string;
  closedAt: string | null;
  /** Where the item came from. Missing on items stored before manual items existed: those are "extracted". */
  source?: ItemSource;
  /** Your own note on the item (manual items). */
  note?: string | null;
  /** Pinned to the top of its list. */
  starred?: boolean;
  /** Local date "YYYY-MM-DD": hidden from lists until that day. */
  snoozedUntil?: string | null;
}

/** "extracted" from a meeting, or "manual": added by you. */
export type ItemSource = "extracted" | "manual";

/** What one extraction run returns for one meeting. */
export interface ExtractionResult {
  newItems: Array<{
    kind: ItemKind;
    text: string;
    person: string | null;
    quote: string;
    dueAt: string | null;
  }>;
  closes: Array<{ itemId: string; quote: string }>;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ExtractionInput {
  transcript: string;
  user: Pick<User, "name" | "aliases" | "timeZone">;
  meeting: Pick<Meeting, "title" | "startedAt" | "participants">;
  openItems: Array<Pick<Item, "id" | "kind" | "text" | "person">>;
}

export interface Brief {
  userId: string;
  /** Local date "YYYY-MM-DD" in the user's time zone. */
  date: string;
  markdown: string;
  html: string;
  text: string;
  subject: string;
}

export const QUOTE_MAX = 200;

/** Structured brief: built by src/lib/brief/build.ts, rendered to Markdown (brief/markdown.ts) and email (email/render.ts). */
export interface BriefLine {
  itemId: string;
  kind: ItemKind;
  text: string;
  person: string | null;
  quote: string;
  meetingTitle: string;
  /** Meeting start, formatted in the user's zone: "1:51 PM". */
  meetingTime: string;
  /** "Today", "Tomorrow", "Fri" or null. */
  dueLabel: string | null;
  /** Minutes late when overdue, else null. */
  lateMinutes: number | null;
  /** Short lateness label: "4h late", "2d late". */
  lateLabel: string | null;
  /** The meeting the item came from. Optional: added for the day ribbon filter. */
  meetingId?: string;
  /** For the quote peek. Optional: lines built before it simply show less. */
  peek?: QuotePeekInfo;
  /** Added by you rather than read from a meeting. */
  manual?: boolean;
  note?: string | null;
  starred?: boolean;
  /** For editing a manual item: the raw due date. */
  dueAt?: string | null;
  /** Set on lines shown in a Snoozed list: the local date it comes back. */
  snoozedUntil?: string | null;
}

export interface QuotePeekInfo {
  /** Who said the quote, as best we know: "You" on things you owe, the person on things you wait on. */
  speaker: string | null;
  /** "Tue 24 Nov, 5:00 PM" in the user's zone. */
  when: string;
  /** Wispr Flow notes page, only when the stored meeting has one. */
  link: string | null;
}

export interface ClosedLine {
  itemId: string;
  text: string;
  closeQuote: string;
  /** Who said the closing words, when known (the owner of a waiting item). */
  person: string | null;
  closedInMeeting: string;
  closedAtTime: string;
}

export interface BriefModel {
  userId: string;
  date: string;          // YYYY-MM-DD local
  dateLabel: string;     // "Wednesday, 25 November"
  meetingCount: number;  // meetings processed for this local date
  wrap: { meetings: number; made: number; kept: number; late: number };
  /** Every promise (owe item) still open, for the note's Wrap section. Optional: added after v1. */
  openPromises?: number;
  youOwe: BriefLine[];   // overdue first, then by due time
  waitingOn: BriefLine[];
  decisions: BriefLine[];
  closedToday: ClosedLine[];
  stillOpenCount: number; // open items created before today not shown above
  stillOpen: BriefLine[]; // up to 5 oldest-first from before today
  empty: "nothing_owed" | "no_meetings" | null;
  subject: string;
}

/** When the user last looked at Today. `since` is the start of the current look, so a refresh keeps the close moment. */
export interface LastLook {
  lastLookedAt: string;
  /** Closes after this instant belong to this look's "Closed since you last looked". Null on the very first look. */
  since: string | null;
}
