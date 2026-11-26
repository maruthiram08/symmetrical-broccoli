// The AI extras' state for the current user, in either mode: the local ai.json, or (hosted) the
// signed-in user's ai_state row. Call save() after changing it; locally it is a no-op.
import { getAiStore, type AiStore } from "@/server/local/ai-store";
import { isHosted } from "@/server/mode";

export async function currentAi(): Promise<{ ai: AiStore; save: () => Promise<void> }> {
  if (!isHosted()) return { ai: getAiStore(), save: async () => {} };
  const [{ userStore }, { loadAiFor, persistAi }] = await Promise.all([import("@/server/hosted/app"), import("@/server/hosted/ai-state")]);
  const store = await userStore();
  const ai = await loadAiFor(store, store.scope!);
  return { ai, save: () => persistAi(store, store.scope!, ai) };
}
