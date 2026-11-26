// The JSON shapes of the public API and webhooks (documented in docs/API.md). Never includes
// transcripts, tokens or anything not already shown in the app.
import type { Item, Meeting } from "@/lib/types";

export interface ApiItem {
  id: string;
  kind: Item["kind"];
  text: string;
  person: string | null;
  quote: string;
  status: Item["status"];
  dueAt: string | null;
  createdAt: string;
  closedAt: string | null;
  /** How it closed: a meeting's words, a ticket ("Closed in Linear"), or null (by you, or still open). */
  closeReason: string | null;
  source: "extracted" | "manual";
  note: string | null;
  starred: boolean;
  snoozedUntil: string | null;
  meeting: { id: string; title: string; startedAt: string } | null;
  ticket: { provider: string; key: string; url: string } | null;
  /** The item's page in the app. */
  url: string;
}

export function serializeItem(i: Item, meeting: Meeting | null, appUrl: string): ApiItem {
  return {
    id: i.id,
    kind: i.kind,
    text: i.text,
    person: i.person,
    quote: i.quote,
    status: i.status,
    dueAt: i.dueAt,
    createdAt: i.createdAt,
    closedAt: i.closedAt,
    closeReason: i.closeReason ?? i.closeQuote ?? null,
    source: i.source ?? "extracted",
    note: i.note ?? null,
    starred: !!i.starred,
    snoozedUntil: i.snoozedUntil ?? null,
    meeting: meeting ? { id: meeting.id, title: meeting.title, startedAt: meeting.startedAt } : null,
    ticket: i.ticket ? { provider: i.ticket.provider, key: i.ticket.key, url: i.ticket.url } : null,
    url: `${appUrl.replace(/\/+$/, "")}/item/${encodeURIComponent(i.id)}`,
  };
}

export function serializeMeeting(m: Meeting, counts: { owe: number; waiting: number; decision: number }) {
  return {
    id: m.id,
    title: m.title,
    startedAt: m.startedAt,
    participants: m.participants,
    read: !!m.processedAt,
    shared: !!m.shared,
    link: m.link ?? null,
    items: counts,
  };
}
