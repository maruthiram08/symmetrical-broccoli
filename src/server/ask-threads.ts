// Ask conversations for the current workspace, in <workspace>/.daily-brief/ask-threads.json (0600).
// Each workspace has its own: switching workspace switches conversations.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { contextTurns, conversations, emptyState, lineage, threadById, tree, type AskTurn, type ThreadState, type TreeNode } from "@/lib/ask/threads";
import { readJson, writeJson } from "@/server/local/json-file";
import { dataDir } from "@/server/local/paths";

export const threadsPath = () => join(dataDir(), "ask-threads.json");

export function readThreads(path = threadsPath()): ThreadState {
  const s = readJson<ThreadState>(path, emptyState());
  return Array.isArray(s.threads) ? s : emptyState();
}

/** Read, change and write back in one go (single-user app: last write wins). */
export function changeThreads<T>(f: (s: ThreadState) => T, path = threadsPath()): T {
  const s = readThreads(path);
  const out = f(s);
  writeJson(path, s);
  return out;
}

export const newId = () => randomUUID();

export interface ThreadView {
  id: string;
  rootId: string;
  name: string;
  parentId: string | null;
  quote: string | null;
  crumbs: Array<{ id: string; name: string }>;
  /** Turns this thread continues from (its parents' up to the fork). */
  inherited: AskTurn[];
  turns: AskTurn[];
  tree: TreeNode[];
}

export interface ConversationRow { id: string; name: string; branches: number; updatedAt: string }

export function viewOf(s: ThreadState, id: string): ThreadView | null {
  const t = threadById(s, id);
  if (!t) return null;
  const all = contextTurns(s, id);
  return {
    id: t.id, rootId: t.rootId, name: t.name, parentId: t.parentId, quote: t.quote,
    crumbs: lineage(s, id).map((x) => ({ id: x.id, name: x.parentId ? x.name : "Main thread" })),
    inherited: all.slice(0, all.length - t.turns.length),
    turns: t.turns,
    tree: tree(s, t.rootId),
  };
}

export function conversationRows(s: ThreadState): ConversationRow[] {
  return conversations(s).slice(0, 50).map((c) => {
    const members = s.threads.filter((t) => t.rootId === c.id);
    return { id: c.id, name: c.name, branches: members.length - 1, updatedAt: members.reduce((a, t) => (t.updatedAt > a ? t.updatedAt : a), c.updatedAt) };
  });
}

