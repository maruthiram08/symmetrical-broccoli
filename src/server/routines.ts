// Routines storage. The local stores (MemoryStore, and FileStore through change()) have it;
// the hosted store doesn't yet, so pages and jobs ask routineStore() and skip routines when it's null.
import type { Occurrence, Routine, RoutineSuggestion } from "@/lib/routines/types";

export interface RoutineStore {
  listRoutines(userId: string): Promise<Routine[]>;
  /** Add or replace a routine (by id). */
  saveRoutine(routine: Routine): Promise<Routine>;
  deleteRoutine(userId: string, routineId: string): Promise<boolean>;
  listOccurrences(userId: string): Promise<Occurrence[]>;
  /** Set one occurrence (routine + local date), or clear it with null. False when the routine is gone. */
  setOccurrence(userId: string, routineId: string, date: string, mark: Pick<Occurrence, "status" | "until"> | null, at: string): Promise<boolean>;
  listRoutineSuggestions(userId: string): Promise<RoutineSuggestion[]>;
  /** Add suggestions, leaving out any already made from the same meeting and quote (also dismissed ones). Returns how many were new. */
  addRoutineSuggestions(userId: string, suggestions: Array<Omit<RoutineSuggestion, "id" | "userId" | "status">>): Promise<number>;
  setRoutineSuggestionStatus(userId: string, id: string, status: RoutineSuggestion["status"]): Promise<RoutineSuggestion | null>;
  /** Record a routine notification by key. False when it was already sent. */
  markRoutineNotified(userId: string, key: string): Promise<boolean>;
}

const METHODS: Array<keyof RoutineStore> = [
  "listRoutines", "saveRoutine", "deleteRoutine", "listOccurrences", "setOccurrence",
  "listRoutineSuggestions", "addRoutineSuggestions", "setRoutineSuggestionStatus", "markRoutineNotified",
];

/** The store's routines, or null when this store has none (hosted, for now). */
export function routineStore(store: unknown): RoutineStore | null {
  const s = store as Partial<Record<keyof RoutineStore, unknown>> | null;
  return s && METHODS.every((m) => typeof s[m] === "function") ? (s as unknown as RoutineStore) : null;
}
