// Types for "Start this" hand-offs: drafting a message or a Claude context pack for an open item.
// Nothing here sends anything. The user copies or opens the target and sends it themselves.
import type { ItemKind, ItemStatus } from "../types";

export type HandoffTarget = "slack" | "email" | "claude";
export const HANDOFF_TARGETS: HandoffTarget[] = ["slack", "email", "claude"];

export const TARGET_LABEL: Record<HandoffTarget, string> = { slack: "Slack", email: "Mail", claude: "Claude" };

/** Everything a draft may use. Built from stored items and meetings only: never a transcript. */
export interface HandoffContext {
  user: { name: string; timeZone: string };
  item: { id: string; kind: Exclude<ItemKind, "decision">; text: string; person: string | null; quote: string; dueAt: string | null };
  meeting: { title: string; startedAt: string } | null;
  /** Other items with the same person, newest first. */
  related: Array<{ kind: ItemKind; text: string; status: ItemStatus; meetingTitle: string | null }>;
  /** Now, for "overdue" wording. ISO. */
  now: string;
}

export interface MessageDraft {
  slack: string;
  emailSubject: string;
  emailBody: string;
}

export interface Drafts extends MessageDraft {
  /** "ai" when Claude wrote it and it passed validation; "template" otherwise (per field set). */
  slackSource: "ai" | "template";
  emailSource: "ai" | "template";
  /** The Claude context pack (always built locally). */
  claudePrompt: string;
}
