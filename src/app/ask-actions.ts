"use server";

// Ask conversations: open one, branch a side thread from an answer or a cited quote, rename and
// delete branches. Kept per workspace (src/server/ask-threads.ts).
import { branch, remove, rename, threadById } from "@/lib/ask/threads";
import { changeThreads, conversationRows, newId, readThreads, viewOf, type ConversationRow, type ThreadView } from "@/server/ask-threads";
import { me } from "@/server/local/app";

const ID = /^[A-Za-z0-9-]{1,80}$/;

export async function openThreadAction(id: string): Promise<{ view: ThreadView | null; conversations: ConversationRow[] }> {
  if (!(await me())) return { view: null, conversations: [] };
  const s = readThreads();
  return { view: typeof id === "string" && ID.test(id) ? viewOf(s, id) : null, conversations: conversationRows(s) };
}

export async function branchAction(parentId: string, turnId: string, quote: string | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!(await me())) return { ok: false, error: "Set up Daily brief first." };
  if (!ID.test(String(parentId)) || !ID.test(String(turnId))) return { ok: false, error: "Couldn't branch from that." };
  const q = typeof quote === "string" ? quote.slice(0, 600) : null;
  const t = changeThreads((s) => {
    // The answer may be one the thread continues from: fork from the thread that owns it.
    const root = threadById(s, parentId)?.rootId;
    const owner = s.threads.find((x) => x.rootId === root && x.turns.some((y) => y.id === turnId));
    return owner ? branch(s, { id: newId(), parentId: owner.id, turnId, quote: q, now: new Date().toISOString() }) : null;
  });
  return t ? { ok: true, id: t.id } : { ok: false, error: "That answer is gone." };
}

export async function renameThreadAction(id: string, name: string): Promise<{ ok: boolean }> {
  if (!(await me()) || !ID.test(String(id)) || typeof name !== "string") return { ok: false };
  return { ok: changeThreads((s) => rename(s, id, name)) };
}

/** Deletes a branch (and its own branches), or a whole conversation. Returns where to go next. */
export async function deleteThreadAction(id: string): Promise<{ ok: boolean; next: string | null }> {
  if (!(await me()) || !ID.test(String(id))) return { ok: false, next: null };
  return changeThreads((s) => {
    const t = threadById(s, id);
    const next = t?.parentId ?? null;
    return { ok: remove(s, id).length > 0, next };
  });
}
