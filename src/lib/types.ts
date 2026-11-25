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
}

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
  /** Tomorrow's meetings from the calendar cache. Missing when the calendar was never read. */
  tomorrow?: GlanceMeeting[];
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

// ---------- calendar (src/lib/calendar, src/server/jobs/calendar.ts) ----------

/** A calendar event from Wispr Flow's search_calendar_events. Timed events only (all-day ones are dropped). */
export interface CalendarEvent {
  calendarId: string;
  title: string;
  startsAt: string; // ISO UTC
  /** Null when the calendar gave no end; treated as 30 minutes long. */
  endsAt: string | null;
  /** Attendee names (or email addresses when no name is given). */
  attendees: string[];
  /** The calendar's recurring-series id, when the event says it has one. */
  recurringId?: string | null;
}

/** Recorded meetings that belong to one recurring calendar series (list_meeting_series). */
export interface MeetingSeries {
  /** Short stable id used in /series/[id]. */
  id: string;
  title: string;
  /** Wispr Flow meeting ids of every recorded occurrence we know of. */
  providerMeetingIds: string[];
  recurringId?: string | null;
}

/** Calendar data cached by the poll. Refetched once `nextFetchAt` passes (30 minutes), on success or failure. */
export interface CalendarCache {
  /** Last successful read of events; null when it never worked. */
  fetchedAt: string | null;
  nextFetchAt: string;
  /** [fromIso, toIso) the events cover. */
  fromIso: string;
  toIso: string;
  events: CalendarEvent[];
  series: MeetingSeries[];
  /** Wispr Flow meeting id -> series id, or null when it is not recurring. Checked once each. */
  seriesChecked: Record<string, string | null>;
}

/** One of tomorrow's meetings with what's open with its people (Wrap and the daily note). */
export interface GlanceMeeting {
  calendarId: string;
  title: string;
  /** "10:30 AM" in the user's zone. */
  time: string;
  startsAt: string;
  people: string[];
  seriesId: string | null;
  /** Listed under this meeting: open items with its people not listed under a smaller or earlier one. */
  owe: GlanceItem[];
  waiting: GlanceItem[];
  /** Open items with its people that are listed under another of tomorrow's meetings, and where. */
  alsoOpen: number;
  alsoIn: string[];
}

export interface GlanceItem {
  itemId: string;
  text: string;
  person: string | null;
  /** "Today", "Fri", "2d late" or null. */
  when: string | null;
  late: boolean;
}
