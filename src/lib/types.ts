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
