// Your own items, stars and snoozes: small pure helpers shared by the store, the brief and the pages.

import type { BriefLine, Item } from "@/lib/types";

/** Manual items belong to no meeting; they carry this in meetingId. */
export const MANUAL_MEETING_ID = "manual";

export const isManual = (i: Pick<Item, "source">) => i.source === "manual";

/** Hidden until its snooze date (a local "YYYY-MM-DD"), shown again on that day. */
export const isSnoozed = (i: Pick<Item, "snoozedUntil">, today: string) => !!i.snoozedUntil && i.snoozedUntil > today;

/** Stable sort with starred items first. */
export function starredFirst<T extends { starred?: boolean }>(xs: T[]): T[] {
  return xs.map((x, k) => [x, k] as const).sort(([a, i], [b, j]) => Number(!!b.starred) - Number(!!a.starred) || i - j).map(([x]) => x);
}

/** The BriefLine fields for your own items, stars and editing. Spread into any line built from an item. */
export function lineExtras(i: Item): Pick<BriefLine, "manual" | "note" | "starred" | "dueAt" | "tags" | "project" | "projectAuto"> {
  return {
    manual: isManual(i) || undefined, note: i.note ?? null, starred: !!i.starred || undefined, dueAt: i.dueAt,
    ...(i.tags?.length ? { tags: i.tags } : {}), ...(i.project ? { project: i.project } : {}),
    ...(i.project && i.projectBy === "auto" ? { projectAuto: i.projectWhy ?? "filed automatically" } : {}),
  };
}

/** Items stored before manual items existed have no source: they came from meetings. */
export function migrateItem(i: Item): Item {
  return i.source ? i : { ...i, source: "extracted" };
}

export interface ManualInput {
  kind: "owe" | "waiting";
  text: string;
  person: string | null;
  dueAt: string | null;
  note?: string | null;
  /** Lands in the Inbox (status "inbox") instead of the lists, to be triaged later. */
  inbox?: boolean;
  /** Tags and project (quick capture's #tag and +project). */
  tags?: string[];
  project?: string | null;
}

/** Quick-captured with neither a person nor a due date: it goes to the Inbox. */
export const goesToInbox = (input: { person?: string | null; dueAt?: string | null }) => !input.person?.trim() && !input.dueAt;

/** A new manual item, shaped exactly like an extracted one. */
export function manualItem(id: string, userId: string, input: ManualInput, at: string): Item {
  return {
    id, userId, kind: input.kind, text: input.text.trim(), person: input.person?.trim() || null,
    quote: "", meetingId: MANUAL_MEETING_ID, dueAt: input.dueAt, status: input.inbox ? "inbox" : "open",
    closedByMeetingId: null, closeQuote: null, createdAt: at, closedAt: null,
    source: "manual", note: input.note?.trim() || null, starred: false, snoozedUntil: null,
    ...(input.tags?.length ? { tags: [...new Set(input.tags)] } : {}), ...(input.project ? { project: input.project } : {}),
  };
}
