import type { TicketProvider } from "@/lib/types";
import type { ProviderConfigs } from "./config";
import type { Fetch } from "./http";

/** What goes into a ticket, built from an item (ticket.ts). */
export interface TicketInput {
  title: string;
  /** The verbatim quote, or your note on items you added. Empty when there is neither. */
  quote: string;
  /** Who said it, when known. */
  speaker: string | null;
  meetingTitle: string | null;
  /** "Tue 24 Nov 2026" in your zone. */
  dateLabel: string | null;
  /** The item's page on this Mac: http://localhost:4242/item/<id>. */
  link: string;
  /** Who to assign: the person who owes it (waiting on), or you (you owe). */
  assigneeName: string | null;
  /** YYYY-MM-DD in your zone, when the item has a due date. */
  dueDate: string | null;
}

/** Plain-text description, shared by providers that take Markdown (Linear, Todoist). */
export function markdownDescription(t: TicketInput): string {
  const lines: string[] = [];
  if (t.quote) lines.push(`> ${t.quote.replace(/\n+/g, " ")}${t.speaker ? `\n> — ${t.speaker}` : ""}`, "");
  if (t.meetingTitle) lines.push(`From **${t.meetingTitle}**${t.dateLabel ? `, ${t.dateLabel}` : ""}.`, "");
  else if (t.dateLabel) lines.push(`Added ${t.dateLabel}.`, "");
  lines.push(`[Open in Daily brief](${t.link})`);
  return lines.join("\n");
}

export interface CreatedTicket {
  id: string;
  key: string;
  url: string;
  /** Who it was assigned to, when the guess matched someone. */
  assignee: string | null;
}

export type TicketState = "open" | "closed" | "missing";

export interface Provider<P extends TicketProvider = TicketProvider> {
  id: P;
  label: string;
  /** Checks the token and settings; may fill derived settings (team id, title property). */
  verify(cfg: ProviderConfigs[P], token: string, fetch: Fetch): Promise<{ message: string; patch?: Partial<ProviderConfigs[P]> }>;
  /** Why the settings aren't enough to make a ticket yet, or null. */
  incomplete(cfg: ProviderConfigs[P]): string | null;
  create(cfg: ProviderConfigs[P], token: string, t: TicketInput, fetch: Fetch): Promise<CreatedTicket>;
  state(cfg: ProviderConfigs[P], token: string, ticket: { id: string; key: string }, fetch: Fetch): Promise<TicketState>;
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Guess who a name ("Nitin", "Nitin K") is among a service's users. Only a confident match counts:
 * the same full name, else exactly one user whose name starts with the same words. Null otherwise,
 * so an unclear guess leaves the ticket unassigned rather than assigned to the wrong person.
 */
export function guessAssignee<T extends { id: string; names: string[] }>(name: string | null, users: T[]): T | null {
  if (!name) return null;
  const want = norm(name);
  if (!want) return null;
  const exact = users.filter((u) => u.names.some((n) => norm(n) === want));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const words = want.split(" ");
  const prefix = (n: string) => {
    const have = norm(n).split(" ");
    // Every word we have matches the start of the same word of theirs: "nitin k" ~ "nitin kumar".
    return words.length <= have.length && words.every((w, k) => have[k].startsWith(w)) && have[0] === words[0];
  };
  const loose = users.filter((u) => u.names.some(prefix));
  return loose.length === 1 ? loose[0] : null;
}
