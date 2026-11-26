// Branching Ask conversations. A conversation is a tree of threads: the main thread, and side
// threads forked from one of its answers (or from a quote cited in it). A side thread sees the
// turns of its parent up to the fork, then its own. Pure; the server keeps them per workspace.
import type { Source } from "./retrieve";

export interface AskTurn {
  id: string;
  question: string;
  answer: string;
  sources: Source[];
  model: string;
  costInr: number | null;
  at: string;
  error?: string | null;
}

export interface AskThread {
  id: string;
  /** The main thread's id; the main thread has its own. */
  rootId: string;
  parentId: string | null;
  /** The parent's turn this thread forks after. */
  forkTurnId: string | null;
  /** The cited quote it was branched from, if any. */
  quote: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  turns: AskTurn[];
}

export interface ThreadState { version: 1; threads: AskThread[] }

export const MAX_THREADS = 500;
export const MAX_TURNS = 100;
export const MAX_NAME = 80;

export function emptyState(): ThreadState {
  return { version: 1, threads: [] };
}

/** "What did we decide about the launch?" -> a short thread name. */
export function nameFrom(text: string, max = 48): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t || "Untitled";
  const cut = t.slice(0, max + 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : t.slice(0, max)).replace(/[\s,;:.-]+$/, "")}…`;
}

export const threadById = (s: ThreadState, id: string) => s.threads.find((t) => t.id === id) ?? null;

/** The threads from the main thread down to this one. */
export function lineage(s: ThreadState, id: string): AskThread[] {
  const out: AskThread[] = [];
  const seen = new Set<string>();
  for (let t = threadById(s, id); t && !seen.has(t.id); t = t.parentId ? threadById(s, t.parentId) : null) {
    seen.add(t.id);
    out.unshift(t);
  }
  return out;
}

/** Every turn this thread sees, oldest first: each ancestor's turns up to its fork, then its own. */
export function contextTurns(s: ThreadState, id: string): AskTurn[] {
  const chain = lineage(s, id);
  const out: AskTurn[] = [];
  chain.forEach((t, k) => {
    const next = chain[k + 1];
    if (!next) { out.push(...t.turns); return; }
    const at = t.turns.findIndex((x) => x.id === next.forkTurnId);
    out.push(...(at === -1 ? t.turns : t.turns.slice(0, at + 1)));
  });
  return out;
}

/** Child threads, oldest first. */
export const childrenOf = (s: ThreadState, id: string) =>
  s.threads.filter((t) => t.parentId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Main threads, newest activity first. */
export function conversations(s: ThreadState): AskThread[] {
  const latest = (root: AskThread) => s.threads.filter((t) => t.rootId === root.id).reduce((a, t) => (t.updatedAt > a ? t.updatedAt : a), root.updatedAt);
  return s.threads.filter((t) => t.parentId === null).sort((a, b) => latest(b).localeCompare(latest(a)));
}

export interface TreeNode { id: string; name: string; depth: number; turns: number; quote: string | null; parentId: string | null }

/** A conversation as a flat, indented list (depth-first), for the thread tree. */
export function tree(s: ThreadState, rootId: string): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (t: AskThread, depth: number) => {
    out.push({ id: t.id, name: t.name, depth, turns: t.turns.length, quote: t.quote, parentId: t.parentId });
    if (depth < 20) for (const c of childrenOf(s, t.id)) walk(c, depth + 1);
  };
  const root = threadById(s, rootId);
  if (root) walk(root, 0);
  return out;
}

export function newConversation(s: ThreadState, opts: { id: string; name: string; now: string }): AskThread {
  const t: AskThread = { id: opts.id, rootId: opts.id, parentId: null, forkTurnId: null, quote: null, name: opts.name.slice(0, MAX_NAME), createdAt: opts.now, updatedAt: opts.now, turns: [] };
  s.threads.push(t);
  trim(s);
  return t;
}

/** Forks a side thread after one of the parent's turns (the main thread stays as it is). */
export function branch(s: ThreadState, opts: { id: string; parentId: string; turnId: string; quote?: string | null; name?: string; now: string }): AskThread | null {
  const parent = threadById(s, opts.parentId);
  if (!parent) return null;
  const turn = parent.turns.find((t) => t.id === opts.turnId);
  if (!turn) return null;
  const quote = opts.quote?.trim() ? opts.quote.trim().slice(0, 600) : null;
  const t: AskThread = {
    id: opts.id, rootId: parent.rootId, parentId: parent.id, forkTurnId: turn.id, quote,
    name: (opts.name?.trim() || (quote ? `“${nameFrom(quote, 36)}”` : `From: ${nameFrom(turn.question, 36)}`)).slice(0, MAX_NAME),
    createdAt: opts.now, updatedAt: opts.now, turns: [],
  };
  s.threads.push(t);
  trim(s);
  return t;
}

export function addTurn(s: ThreadState, threadId: string, turn: AskTurn): AskThread | null {
  const t = threadById(s, threadId);
  if (!t) return null;
  t.turns.push(turn);
  if (t.turns.length > MAX_TURNS) t.turns.splice(0, t.turns.length - MAX_TURNS);
  t.updatedAt = turn.at;
  if (t.parentId === null && t.turns.length === 1) t.name = nameFrom(turn.question);
  return t;
}

export function rename(s: ThreadState, id: string, name: string): boolean {
  const t = threadById(s, id);
  const n = name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  if (!t || !n) return false;
  t.name = n;
  return true;
}

/** Deletes a thread and every thread branched from it. Returns the ids removed. */
export function remove(s: ThreadState, id: string): string[] {
  const gone = new Set<string>();
  const mark = (x: string) => { gone.add(x); for (const c of s.threads.filter((t) => t.parentId === x)) if (!gone.has(c.id)) mark(c.id); };
  if (!threadById(s, id)) return [];
  mark(id);
  s.threads = s.threads.filter((t) => !gone.has(t.id));
  return [...gone];
}

/** Keeps the newest MAX_THREADS conversations' worth (oldest conversations go first). */
function trim(s: ThreadState): void {
  if (s.threads.length <= MAX_THREADS) return;
  const keep = new Set<string>();
  for (const root of conversations(s)) {
    const members = s.threads.filter((t) => t.rootId === root.id);
    if (keep.size + members.length > MAX_THREADS) break;
    members.forEach((m) => keep.add(m.id));
  }
  s.threads = s.threads.filter((t) => keep.has(t.id));
}
