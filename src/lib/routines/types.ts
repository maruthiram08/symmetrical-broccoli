// Routines: things you do regularly ("send the sprint report every Friday"). Not items: they never
// count as open, never close from a meeting, and each occurrence is ticked on its own day.

/** Days of the week, 0 = Sunday (as Date.getUTCDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Cadence =
  | { kind: "daily" }
  /** Monday to Friday. */
  | { kind: "weekdays" }
  /** On these days of the week (at least one). */
  | { kind: "weekly"; days: Weekday[] }
  /** On day N of the month; a day past the month's end means its last day (31 -> 30 Apr, 28/29 Feb). */
  | { kind: "monthly"; day: number }
  /** Every N days, counted from `from` (a local date, which is itself due). */
  | { kind: "every"; n: number; from: string };

export type RoutineSource =
  | { type: "manual" }
  | { type: "meeting"; meetingId: string; quote: string };

export interface Routine {
  id: string;
  userId: string;
  title: string;
  cadence: Cadence;
  /** Local "HH:MM", or null for any time that day. */
  time: string | null;
  /** Who it is owed to, if anyone. */
  person: string | null;
  createdAt: string;
  archived: boolean;
  source: RoutineSource;
}

/** What happened to one occurrence (one due local date) of a routine. */
export interface Occurrence {
  routineId: string;
  /** The local date it was due, YYYY-MM-DD. */
  date: string;
  status: "done" | "skipped" | "snoozed";
  /** Snoozed: the local date it comes back on. */
  until?: string;
  at: string;
}

/** A recurring promise found in a meeting, waiting for the user to Add or Dismiss it. */
export interface RoutineSuggestion {
  id: string;
  userId: string;
  title: string;
  cadence: Cadence;
  time: string | null;
  person: string | null;
  meetingId: string;
  quote: string;
  /** The cadence words the reader returned ("every Friday"). */
  recurrence: string;
  createdAt: string;
  status: "open" | "added" | "dismissed";
}

/** Everything routines keep per user (one entry in the state file). */
export interface RoutineDoc {
  routines: Routine[];
  occurrences: Occurrence[];
  suggestions: RoutineSuggestion[];
  /** "routineId:date" of occurrences already announced with a notification (newest last). */
  notified: string[];
}

export const emptyRoutineDoc = (): RoutineDoc => ({ routines: [], occurrences: [], suggestions: [], notified: [] });

/** One routine due on Today and in the brief. */
export interface RoutineLine {
  routineId: string;
  title: string;
  person: string | null;
  time: string | null;
  /** "Every Friday" */
  cadenceLabel: string;
  /** The occurrence a tick marks: today, or the latest missed day when it isn't due today. */
  date: string;
  /** The earliest missed occurrence still open (within the window), or null when not overdue. */
  overdueSince: string | null;
  /** "overdue since Mon", or null. */
  overdueLabel: string | null;
}
