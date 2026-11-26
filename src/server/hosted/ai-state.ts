// The AI extras' state (nudge drafts, changed-decision flags) for one hosted user. The local
// AiStore keeps it in ai.json and has a synchronous API; here it is loaded from ai_state into
// memory, changed with the same API, and written back with persist().
import { AiStore, emptyAiState, type AiState } from "@/server/local/ai-store";
import type { HostedStore } from "./store";

export class SnapshotAiStore extends AiStore {
  dirty = false;
  constructor(state: Partial<AiState> | null) {
    super("");
    this.s = { ...emptyAiState(), ...(state ?? {}) };
  }
  protected reload(): void {}
  protected flush(): void { this.s.checked = this.s.checked.slice(-5000); this.dirty = true; }
  snapshot(): AiState { return this.s; }
}

export async function loadAiFor(store: HostedStore, userId: string): Promise<SnapshotAiStore> {
  return new SnapshotAiStore((await store.getAiState(userId)) as Partial<AiState> | null);
}

/** Write back what changed. Does nothing when nothing did. */
export async function persistAi(store: HostedStore, userId: string, ai: SnapshotAiStore): Promise<void> {
  if (!ai.dirty) return;
  await store.saveAiState(userId, ai.snapshot() as unknown as Record<string, unknown>);
  ai.dirty = false;
}
