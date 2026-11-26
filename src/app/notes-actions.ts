"use server";

// The notes editor: pages, link targets, slash-command items, checkbox sync and writing assist.
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { localDate, zonedTime } from "@/lib/brief/time";
import { DUE_TIME } from "@/lib/capture/parse";
import type { LinkTarget } from "@/lib/editor/commands";
import { ASSIST_MAX_CHARS, ASSIST_MODES, estimateAssist, runAssist, type AssistResult } from "@/lib/editor/assist";
import { itemLine, parseItemCommand } from "@/lib/editor/slash";
import { formatInr } from "@/lib/ai/common";
import { env } from "@/lib/env";
import { aiClient } from "@/server/ai";
import { getStore, me } from "@/server/local/app";
import { createPage, deletePage, listPages, savePage, validSlug, type SaveResult } from "@/server/local/pages";
import { captureContextAction } from "./capture-actions";
import { loadAll } from "./_lib/lines";
import { groupNames } from "@/lib/people";
import { assistStatusFor } from "./_lib/editor";

const SLUG = z.string().min(1).max(80).refine(validSlug);

export async function saveNoteAction(slug: string, markdown: string, base: string | null): Promise<SaveResult> {
  if (!SLUG.safeParse(slug).success || typeof markdown !== "string") return { ok: false, error: "Couldn't save." };
  if (!(await me())) return { ok: false, error: "Set up Daily brief first." };
  try {
    return savePage(slug, markdown, typeof base === "string" ? base : null);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save." };
  }
}

export async function createNoteAction(title: string): Promise<{ ok: true; slug: string } | { ok: false; error: string }> {
  const t = z.string().trim().max(120).safeParse(title);
  if (!t.success) return { ok: false, error: "Give it a shorter title." };
  if (!(await me())) return { ok: false, error: "Set up Daily brief first." };
  const { slug } = createPage(t.data || "Untitled");
  revalidatePath("/notes");
  return { ok: true, slug };
}

/** The form on /notes: make a page, then open it. */
export async function newNoteFormAction(formData: FormData): Promise<void> {
  const r = await createNoteAction(String(formData.get("title") ?? ""));
  if (r.ok) {
    const { redirect } = await import("next/navigation");
    redirect(`/notes/${encodeURIComponent(r.slug)}`);
  }
}

export async function deleteNoteAction(formData: FormData): Promise<void> {
  const slug = SLUG.safeParse(formData.get("slug"));
  if (!slug.success || !(await me())) return;
  deletePage(slug.data);
  revalidatePath("/notes");
  const { redirect } = await import("next/navigation");
  redirect("/notes");
}

const short = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });

/** Everything [[ can link: people, notes, recent meetings and items. */
export async function linkTargetsAction(): Promise<LinkTarget[]> {
  const user = await me();
  if (!user) return [];
  const { items, meetings } = await loadAll(user);
  const out: LinkTarget[] = [];
  // People with a page: everyone named on an item, one entry per person however it was spelled.
  for (const g of groupNames(items.filter((i) => i.status !== "wrong").map((i) => i.person ?? "").filter(Boolean), [user.name, ...user.aliases])) {
    const other = g.spellings.find((s) => s.toLowerCase() !== g.name.toLowerCase() && s.length > g.name.length);
    out.push({ kind: "person", target: g.name, label: g.name, detail: other ? `Person · ${other}` : "Person" });
  }
  for (const n of listPages()) out.push({ kind: "note", target: n.slug, label: n.title, detail: "Note" });
  for (const m of [...meetings].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 80)) {
    out.push({ kind: "meeting", target: m.id, label: m.title || "Meeting", detail: `Meeting · ${short(m.startedAt, user.timeZone)}` });
  }
  const kindLabel = { owe: "You owe", waiting: "Waiting on", decision: "Decision" } as const;
  const open = items.filter((i) => i.status === "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  for (const i of open) out.push({ kind: "item", target: i.id, label: i.text, detail: `${kindLabel[i.kind]}${i.person ? ` · ${i.person}` : ""}` });
  return out;
}

/** /todo, /owe, /waiting: add one of your own items from the line, and give back the note line for it. */
export async function addItemFromNoteAction(input: { id: "todo" | "owe" | "waiting"; arg: string; indent: string }): Promise<{ ok: true; line: string } | { ok: false; error: string }> {
  const p = z.object({ id: z.enum(["todo", "owe", "waiting"]), arg: z.string().trim().min(1).max(300), indent: z.string().max(40) }).safeParse(input);
  if (!p.success) return { ok: false, error: "Say what it is." };
  const user = await me();
  const ctx = await captureContextAction();
  if (!user || !ctx) return { ok: false, error: "Set up Daily brief first." };
  const parsed = parseItemCommand(p.data.id, p.data.arg, { people: ctx.people, self: ctx.self, timeZone: ctx.timeZone, now: new Date() });
  if (!parsed) return { ok: false, error: "Say what it is." };
  const item = await getStore().addManualItem(user.id, {
    kind: parsed.kind, text: parsed.text.slice(0, 300), person: parsed.person, note: null,
    dueAt: parsed.dueDate ? zonedTime(parsed.dueDate, DUE_TIME, user.timeZone).toISOString() : null,
  }, new Date().toISOString());
  revalidatePath("/", "layout");
  return { ok: true, line: itemLine(parsed, item.id, p.data.indent) };
}

/** Ticking an item's checkbox in a note marks the item done (and unticking reopens it). */
export async function setItemDoneFromNoteAction(id: string, done: boolean): Promise<{ ok: boolean }> {
  const user = await me();
  if (!user || typeof id !== "string" || id.length > 100) return { ok: false };
  const item = (await getStore().listItems(user.id)).find((i) => i.id === id);
  if (!item || item.kind === "decision") return { ok: false };
  if (done && item.status === "open") await getStore().setItemStatus(id, "done", new Date().toISOString());
  else if (!done && item.status === "done") await getStore().setItemStatus(id, "open", new Date().toISOString());
  else return { ok: true };
  revalidatePath("/", "layout");
  return { ok: true };
}

// ---------- writing assist ----------

const AssistBody = z.object({ mode: z.enum(ASSIST_MODES), text: z.string().min(1).max(ASSIST_MAX_CHARS) });

export async function assistEstimateAction(mode: string, text: string): Promise<{ costLabel: string | null }> {
  const p = AssistBody.safeParse({ mode, text });
  if (!p.success) return { costLabel: null };
  const e = estimateAssist(p.data.mode, p.data.text, env.extractionModel);
  return { costLabel: formatInr(e.costInr) };
}

export async function assistAction(mode: string, text: string): Promise<AssistResult & { costLabel?: string | null }> {
  const p = AssistBody.safeParse({ mode, text });
  if (!p.success) return { ok: false, error: text.length > ASSIST_MAX_CHARS ? "Select less text." : "Select some text first." };
  const user = await me();
  if (!user) return { ok: false, error: "Set up Daily brief first." };
  const status = await assistStatusFor();
  if (!status.enabled) return { ok: false, error: status.reason };
  const client = aiClient();
  if (!client) return { ok: false, error: "Add ANTHROPIC_API_KEY to use writing assist." };
  const model = env.extractionModel;
  const r = await runAssist(p.data.mode, p.data.text, { client, model });
  const store = getStore();
  if (!r.ok && (r.failure === "auth" || r.failure === "credit")) {
    // The same banner extraction and Ask raise.
    await store.setHealth({ anthropicProblem: { kind: r.failure, at: new Date().toISOString() } });
    revalidatePath("/", "layout");
  }
  if (r.ok && (await store.getHealth()).anthropicProblem) await store.setHealth({ anthropicProblem: null });
  if (r.usage) {
    await store.logEvent({
      userId: user.id, type: "assist", payload: { model, mode: p.data.mode, ok: r.ok, chars: p.data.text.length },
      tokensIn: r.usage.inputTokens, tokensOut: r.usage.outputTokens, costInr: r.costInr ?? undefined,
    });
  }
  return { ...r, costLabel: r.costInr !== undefined ? formatInr(r.costInr) : null };
}

/** Today's local date in your zone, for /date and the Today view. */
export async function todayAction(): Promise<string> {
  const user = await me();
  return localDate(new Date(), user?.timeZone ?? "UTC");
}
