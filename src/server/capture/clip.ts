// Capture from the clipboard (the Mac app's shortcut): what was copied becomes one item, filed into
// a project like any other. Parsing is local (src/lib/capture/slack.ts); nothing talks to Slack.
import { localDate } from "@/lib/brief/time";
import { clipToItem, parseClip } from "@/lib/capture/slack";
import { goesToInbox } from "@/lib/capture/items";
import type { AppStore } from "@/server/app-store";
import type { Item, User } from "@/lib/types";
import { autoFileProjects, type FilingStore } from "@/server/structure/autofile";

export interface CaptureResult {
  id: string;
  kind: Item["kind"];
  text: string;
  person: string | null;
  inbox: boolean;
  project: string | null;
  slack: boolean;
}

export async function captureClip(
  store: Pick<AppStore, "addManualItem" | "listItems"> & FilingStore,
  user: User,
  clip: { text: string; html?: string | null },
  now = new Date(),
): Promise<CaptureResult | null> {
  const parsed = parseClip(clip.text, clip.html);
  const ctx = { self: [user.name, ...user.aliases].filter(Boolean), now, timeZone: user.timeZone, today: localDate(now, user.timeZone) };
  const c = clipToItem(parsed, ctx);
  if (!c) return null;
  const inbox = goesToInbox({ person: c.person, dueAt: c.dueAt });
  const item = await store.addManualItem(user.id, {
    kind: c.kind, text: c.text, person: c.person, dueAt: c.dueAt, inbox, quote: c.quote,
    origin: { ...c.origin, text: c.full },
  }, now.toISOString());
  // The usual filing: the item goes to the project it clearly fits, or stays in "Needs a project".
  try { await autoFileProjects(store, user.id); } catch (e) { console.error("[capture] filing", e instanceof Error ? e.message : e); }
  const filed = (await store.listItems(user.id)).find((i) => i.id === item.id);
  return { id: item.id, kind: item.kind, text: item.text, person: item.person, inbox, project: filed?.project ?? null, slack: c.origin.app === "slack" };
}
