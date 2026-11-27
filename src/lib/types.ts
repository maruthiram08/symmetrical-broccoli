// Shared domain types. Every module imports from here; keep it the single source of truth.

export type ItemKind = "owe" | "waiting" | "decision";
/** "inbox": captured by you without a person or due date, waiting in the Inbox to be triaged. */
export type ItemStatus = "open" | "done" | "wrong" | "inbox";

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
  /** Settings: capture sources beyond Wispr Flow (src/server/recorders). Missing = all off. */
  sources?: SourceSettings;
  createdAt: string;
}

/** Where a meeting was recorded. Meetings stored before this existed are "wispr_flow". */
export type MeetingProvider = "wispr_flow" | "granola" | "zoom" | "google_meet" | "file" | "phone";

/** A local capture source the user turned on. Every source is off until turned on in Settings. */
export interface SourceToggle {
  enabled: boolean;
  /** Meetings that started before this (ISO) are not read: set to 7 days back when turned on, so old history isn't read (and paid for) at once. */
  since?: string | null;
  /** Folder or file to read instead of the default. */
  path?: string | null;
}

export interface SourceSettings {
  granola?: SourceToggle;
  zoom?: SourceToggle;
  /** Google Meet transcripts and any other transcript file dropped in the inbox folder. */
  files?: SourceToggle;
  /** Phone-call transcripts dropped in the inbox folder. Shares the inbox folder with `files`. */
  phone?: SourceToggle;
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
  /** Which recorder it came from. Missing = "wispr_flow" (older data); see providerOf. */
  provider?: MeetingProvider;
  /** Local recorders: the file the transcript is read from at read time (never the transcript itself). */
  sourcePath?: string | null;
  /** The same meeting recorded by another source: set, the meeting is never read. Holds the kept meeting's id. */
  duplicateOf?: string | null;
}

export function providerOf(m: Pick<Meeting, "provider">): MeetingProvider {
  return m.provider ?? "wispr_flow";
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
  /** Set on read when the people directory resolved `person`: the name as extracted. Never stored. */
  personRaw?: string | null;
  /** Set on read: the directory person this item belongs to. Never stored. */
  personId?: string;
  /** Set on read when the person was only a speaker label ("Speaker 5"): shown as nobody. Never stored. */
  unattributed?: boolean;
  /** A ticket made from this item in Jira, Linear, Notion or Todoist (src/server/integrations). */
  ticket?: ItemTicket | null;
  /** Why it closed when neither a meeting nor you closed it: "Closed in Linear". */
  closeReason?: string | null;
  /** Your tags ("launch", "q4/plan"), lower case. Missing = none. */
  tags?: string[];
  /** The project note (slug of a note of type Project) it belongs to. Missing = none. */
  project?: string | null;
  /** Who filed it: "auto" (src/lib/projects/autofile) or "you". Missing with a project = you, before auto-filing. */
  projectBy?: "auto" | "you" | null;
  /** Why an automatic filing chose its project: `matched “stock split”`. */
  projectWhy?: string | null;
  /** Captured from the clipboard (the Mac app's shortcut): where the message came from. */
  origin?: ItemOrigin | null;
}

/** A captured message: Slack (permalink, sender, when) or any other copied text. */
export interface ItemOrigin {
  app: "slack" | "clipboard";
  /** The Slack permalink, when the copy had one. */
  url: string | null;
  /** Who wrote the message, as Slack showed the name. */
  from: string | null;
  /** When the message was sent (UTC ISO), from the permalink. */
  sentAt: string | null;
  /** "acme" in acme.slack.com. */
  workspace: string | null;
  /** Everything that was copied (a thread keeps every message). */
  text: string;
}

export type TicketProvider = "jira" | "linear" | "notion" | "todoist";

export interface ItemTicket {
  provider: TicketProvider;
  /** The provider's own id (Jira issue id, Linear issue id, Notion page id, Todoist task id). */
  id: string;
  /** What we show: "LIN-123", "OPS-7", "Notion", "Todoist". */
  key: string;
  url: string;
  createdAt: string;
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
    /** Owe/waiting: "label" when the speaker labels alone showed who promised, "content" when transcript cues decided it. Missing when the model didn't say. */
    attribution?: Attribution;
    /** Owe items the user said they'll do regularly: the cadence in words ("every Friday"). Becomes a routine suggestion (src/lib/routines). */
    recurrence?: string;
  }>;
  closes: Array<{ itemId: string; quote: string }>;
  usage: { inputTokens: number; outputTokens: number };
  /** Items the model proposed that post-processing dropped, and why (logged, never shown as items). */
  dropped?: Array<{ reason: string; text: string }>;
}

export type Attribution = "label" | "content";

export interface ExtractionInput {
  transcript: string;
  user: Pick<User, "name" | "aliases" | "timeZone">;
  meeting: Pick<Meeting, "title" | "startedAt" | "participants"> & Partial<Pick<Meeting, "shared" | "ownerName">>;
  openItems: Array<Pick<Item, "id" | "kind" | "text" | "person">>;
  /** People the user confirmed, with their other spellings, so names come back as the known spelling. */
  knownPeople?: Array<{ name: string; aliases: string[] }>;
  /** Open decisions from earlier meetings, so a repeated decision isn't recorded again. */
  openDecisions?: Array<{ text: string }>;
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
  /** Your tags and project (src/lib/structure). Only set when there are some. */
  tags?: string[];
  project?: string | null;
  /** Set when the project was filed automatically: why (shown beside it, with a way to correct it). */
  projectAuto?: string;
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
  /** Routines due today (and overdue ones), src/lib/routines. Missing when none, or the store has no routines. */
  routines?: RoutineLine[];
}

/** When the user last looked at Today. `since` is the start of the current look, so a refresh keeps the close moment. */
export interface LastLook {
  lastLookedAt: string;
  /** Closes after this instant belong to this look's "Closed since you last looked". Null on the very first look. */
  since: string | null;
}

import type { RoutineLine } from "./routines/types";

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
