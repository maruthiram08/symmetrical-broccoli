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
  /** Settings: also read meetings others shared with you (Wispr Flow shared=true). Missing = off. */
  includeShared?: boolean;
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
  /** Refreshes in a row that Wispr Flow answered with an error (network failures don't count). */
  refreshFailures?: number;
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
  /** Someone else's meeting shared with the user. Missing on the user's own meetings. */
  shared?: boolean;
  /** Who recorded a shared meeting (Wispr Flow owner.name), when known. */
  ownerName?: string | null;
  /** Failed reads so far (offline and account problems don't count). At MAX_MEETING_ATTEMPTS it is set aside. */
  failedAttempts?: number;
  lastFailedAt?: string | null;
  /** What the last failed read ran into ("extract", "transcript", "transient", ...). */
  lastFailure?: string | null;
}

/** A meeting that failed this many reads is set aside until the user presses Retry. */
export const MAX_MEETING_ATTEMPTS = 4;

/** Anthropic account problems that only the user can fix. */
export type AccountProblem = "auth" | "credit";

/** What the app last managed to do, for the Health section and the banners. */
export interface Health {
  lastPollOkAt?: string | null;
  lastPollErrorAt?: string | null;
  lastExtractOkAt?: string | null;
  lastBriefAt?: string | null;
  /** Set when Anthropic rejects the key or the account is out of credit; cleared by a good read. */
  anthropicProblem?: { kind: AccountProblem; at: string } | null;
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
  meeting: Pick<Meeting, "title" | "startedAt" | "participants"> & Partial<Pick<Meeting, "shared" | "ownerName">>;
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
  /** The item came from a meeting someone else recorded and shared with the user. */
  shared?: boolean;
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
