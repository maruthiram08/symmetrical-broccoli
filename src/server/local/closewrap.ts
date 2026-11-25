import { loadBriefData } from "@/lib/brief/data";
import { closedSince, nextLook, type CloseMomentLine } from "@/lib/brief/looked";
import type { User } from "@/lib/types";
import type { FileStore } from "./file-store";

/**
 * Today's close moment: what later meetings closed since the user last looked.
 * Records this look, so the next visit (after a gap) starts from now.
 */
export async function takeCloseMoment(store: FileStore, user: User, now: Date): Promise<CloseMomentLine[]> {
  const look = nextLook(await store.getLastLook(user.id), now);
  const lines = closedSince(await loadBriefData(store, user.id), look, now, user.timeZone);
  await store.saveLastLook(user.id, look.next);
  return lines;
}
