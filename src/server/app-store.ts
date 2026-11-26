import type { ManualInput } from "@/lib/capture/items";
import type { CalendarCache, Health, Item, LastLook, UpcomingCache, User } from "@/lib/types";
import type { Store } from "@/server/store";
import type { OAuthClientStore } from "@/server/wispr/oauth";

/** The "restored from backup" notice of the local store. The hosted store never has one. */
export interface RecoveryNotice {
  at: string;
  from: string | null;
  corruptFile: string | null;
}

/**
 * Everything the pages, actions and jobs ask of a store: the jobs' Store plus the app's own
 * extras. Two implementations: FileStore (local, src/server/local/file-store.ts) and
 * HostedStore (Supabase Postgres, src/server/hosted/store.ts). getStore() returns one of them.
 */
export interface AppStore extends Required<Store>, OAuthClientStore {
  /** Where the data lives: the state file locally, a label when hosted. */
  readonly path: string;
  updateUser(id: string, patch: Partial<Omit<User, "id">>): Promise<User | null>;
  listEvents(type?: string): Promise<Array<Record<string, unknown>>>;
  getLastLook(userId: string): Promise<LastLook | null>;
  saveLastLook(userId: string, look: LastLook): Promise<void>;
  addManualItem(userId: string, input: ManualInput, at: string): Promise<Item>;
  updateItem(itemId: string, patch: Partial<Pick<Item, "kind" | "text" | "person" | "dueAt" | "note" | "starred" | "snoozedUntil">>): Promise<Item | null>;
  deleteItem(itemId: string): Promise<boolean>;
  setItemDue(userId: string, itemId: string, dueAt: string | null): Promise<boolean>;
  markPrepNotified(key: string): Promise<boolean>;
  resetExtraction(userId: string): Promise<number>;
  getRecovery(): Promise<RecoveryNotice | null>;
  dismissRecovery(): Promise<void>;
  saveUpcoming(userId: string, cache: UpcomingCache): Promise<void>;
  getUpcoming(userId: string): Promise<UpcomingCache | null>;
  saveCalendar(userId: string, cache: CalendarCache): Promise<void>;
  getCalendar(userId: string): Promise<CalendarCache | null>;
  getHealth(): Promise<Health>;
  setHealth(patch: Partial<Health>): Promise<void>;
}
