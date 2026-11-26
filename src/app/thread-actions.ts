"use server";

// Found threads and the People update, all on a press. Keep is the only thing that files: it makes a
// Project note and files the thread's items as yours. AI text runs only when you ask, through the
// provider picked for Nudges in Settings › AI, and "Where it stands" is cached in threads.json.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { metPerson, updateTemplate } from "@/lib/reading/met";
import { signatureOf, type FoundThread } from "@/lib/reading/threads";
import { findPerson } from "@/lib/people";
import type { Item, Meeting, User } from "@/lib/types";
import { aiDepsForJobs } from "@/server/ai";
import { getFileStore, getStore, me } from "@/server/local/app";
import { saveStands, setDismissed } from "@/server/local/threads";
import { isHosted } from "@/server/mode";
import { recordFilings } from "@/server/structure/autofile";
import { resolveProject } from "@/server/structure/notes";
import { loadAll } from "./_lib/lines";
import { loadThreads } from "./_lib/threads";

type Fail = { ok: false; error: string };
const idSchema = z.string().regex(/^t-[a-z0-9-]{1,60}$/);
const done = <T,>(r: T): T => { revalidatePath("/", "layout"); return r; };

async function threadById(id: string): Promise<{ user: User; t: FoundThread; meetings: Meeting[] } | null> {
  const user = await me();
  if (!user) return null;
  const { items, meetings, people } = await loadAll(user);
  const t = loadThreads(user, items, meetings, people).find((x) => x.id === id);
  return t ? { user, t, meetings } : null;
}

/** "Not one thread": hide it from Projects for good (remembered in threads.json). */
export async function dismissThreadAction(id: string, on = true): Promise<{ ok: true } | Fail> {
  const p = idSchema.safeParse(id);
  if (!p.success || !(await me())) return { ok: false, error: "That thread is gone." };
  setDismissed(p.data, on !== false);
  return done({ ok: true });
}

/** "Keep as a project": a Project note named for the thread, with its items filed as yours. */
export async function keepThreadAction(id: string): Promise<{ ok: true; slug: string; filed: number } | Fail> {
  const p = idSchema.safeParse(id);
  if (!p.success) return { ok: false, error: "That thread is gone." };
  if (isHosted()) return { ok: false, error: "Projects live on your Mac." };
  const found = await threadById(p.data);
  if (!found) return { ok: false, error: "That thread is gone." };
  const slug = resolveProject(found.t.name, found.user.timeZone);
  if (!slug) return { ok: false, error: "Couldn't make that project." };
  const filed = await recordFilings(getFileStore(), found.user.id, found.t.items.map((i) => ({ ...i })), slug, new Date().toISOString());
  return done({ ok: true, slug, filed });
}

async function ask(system: string, text: string, maxTokens: number): Promise<{ ok: true; text: string; model: string } | Fail> {
  const deps = await aiDepsForJobs();
  if (!deps.client) return { ok: false, error: "Pick a provider for Nudges in Settings › AI to write this." };
  try {
    const r = await deps.client.messages.create({ model: deps.model, max_tokens: maxTokens, system, messages: [{ role: "user", content: text }] });
    const out = r.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    return out ? { ok: true, text: out, model: deps.model } : { ok: false, error: "The model sent nothing back. Try again." };
  } catch (e) {
    return { ok: false, error: `Couldn't write it (${e instanceof Error ? e.name : "error"}). Try again.` };
  }
}

const STANDS_SYSTEM = "You write a short status of one work thread for the person who was in its meetings. Use only the facts given. 3 to 5 plain sentences, no lists, no headings, no greeting. Say what the scope is now, what's decided, and what is still open and with whom. Write in English.";

/** "Where it stands", written by AI on a press and cached for this exact set of items. */
export async function whereItStandsAction(id: string): Promise<{ ok: true; text: string } | Fail> {
  const p = idSchema.safeParse(id);
  if (!p.success) return { ok: false, error: "That thread is gone." };
  const found = await threadById(p.data);
  if (!found) return { ok: false, error: "That thread is gone." };
  const { t, user, meetings } = found;
  const byId = new Map(meetings.map((m) => [m.id, m]));
  const d = (i: Item) => new Date(byId.get(i.meetingId)?.startedAt ?? i.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: user.timeZone });
  const facts = [
    `Thread: ${t.name}`,
    `Meetings (${t.meetings.length}): ${t.meetings.map((m) => `${m.title || "Meeting"} (${new Date(m.startedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: user.timeZone })})`).join("; ")}`,
    `Decisions, oldest first:\n${t.decisions.map((i) => `- ${d(i)}: ${i.text}`).join("\n") || "- none"}`,
    `Still open:\n${t.open.map((i) => `- ${i.text}${i.person ? ` (with ${i.person})` : ""}, said ${d(i)}`).join("\n") || "- nothing"}`,
    `Kept: ${t.kept}`,
  ].join("\n\n").slice(0, 12000);
  const r = await ask(STANDS_SYSTEM, facts, 600);
  if (!r.ok) return r;
  saveStands(t.id, { sig: t.signature, text: r.text, at: new Date().toISOString(), model: r.model });
  return done({ ok: true, text: r.text });
}

const UPDATE_SYSTEM = "You write one short Slack message from the user to a colleague: a status on what the user owes them. Use only the items given. Start with \"Hi <first name>, a quick status on what I owe you:\", then one bullet (•) per item or per close group of items, each with a plain next step. For the item marked OLDEST, ask \"Still needed, or drop it?\". If items they owe the user are given, add one line asking about them. No sign-off, no emoji, no dates you weren't given.";

const g = globalThis as unknown as { __dbUpdates?: Map<string, string> };
const updates = () => (g.__dbUpdates ??= new Map());

/** The People "Update, ready to send": on a press only. AI through Settings › AI when set, else the template. Cached per set of open items. */
export async function personUpdateAction(slug: string): Promise<{ ok: true; text: string; ai: boolean } | Fail> {
  const s = z.string().min(1).max(120).safeParse(slug);
  const user = await me();
  if (!s.success || !user) return { ok: false, error: "That person is gone." };
  const { items, meetings, people } = await loadAll(user);
  const input = { items, meetings, now: new Date(), self: [user.name, ...user.aliases], people };
  const group = findPerson(s.data, input);
  const p = group ? metPerson(group, input, user.timeZone) : null;
  if (!p) return { ok: false, error: "Nothing open with them." };
  const key = `${p.person.slug}:${signatureOf(p.open)}`;
  const hit = updates().get(key);
  if (hit) return { ok: true, text: hit, ai: true };
  const owe = p.open.filter((i) => i.kind === "owe");
  const wait = p.open.filter((i) => i.kind === "waiting");
  const facts = [`Colleague: ${p.person.name}`, `The user owes them:\n${owe.map((i, n) => `- ${i.text}${n === 0 ? " (OLDEST)" : ""}`).join("\n") || "- nothing"}`, wait.length ? `They owe the user:\n${wait.map((i) => `- ${i.text}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  const r = await ask(UPDATE_SYSTEM, facts, 500);
  if (!r.ok) return { ok: true, text: updateTemplate(p.person.name, p.open), ai: false };
  updates().set(key, r.text);
  return { ok: true, text: r.text, ai: true };
}

/** "Drop <item>": it wasn't a promise after all. */
export async function dropItemAction(id: string): Promise<{ ok: true } | Fail> {
  const user = await me();
  const p = z.string().min(1).max(100).safeParse(id);
  if (!user || !p.success) return { ok: false, error: "That item is gone." };
  const item = (await getStore().listItems(user.id)).find((i) => i.id === p.data);
  if (!item) return { ok: false, error: "That item is gone." };
  await getStore().setItemStatus(item.id, "wrong", new Date().toISOString());
  return done({ ok: true });
}
