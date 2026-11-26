"use server";

// Server actions for the canvas: Ask on chosen context, windows, and the buttons on cards.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { buildAskMessage, fitSources } from "@/lib/ask/prompt";
import { ASK_SYSTEM_PROMPT } from "@/lib/ask/prompt";
import type { ItemSource } from "@/lib/ask/retrieve";
import { startContext } from "@/lib/canvas/build";
import type { CanvasWindow } from "@/lib/canvas/model";
import { addDays, localDate, zonedTime } from "@/lib/brief/time";
import { claudeUrl } from "@/lib/handoff/links";
import { getStore, me } from "@/server/local/app";
import { draftsFor, recordHandoff } from "@/server/handoff";
import { resolveContradiction } from "@/server/ai";
import { canvasAi, canvasCtx, canvasError, getWindow, openInClaudeCode, saveWindow, WINDOW_SYSTEM } from "@/server/canvas/data";

const textOf = (m: { content: Array<{ type: string; text?: string }> }) => m.content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("").trim();

export type AskResult = { ok: true; text: string; sources: Array<{ n: number; itemId: string; title: string }>; via: string } | { ok: false; error: string };

/** Ask, reading only the meetings and items left plugged in on the canvas. */
export async function canvasAsk(question: string, itemIds: string[], meetingIds: string[]): Promise<AskResult> {
  const user = await me();
  if (!user) return { ok: false, error: "Finish setup first." };
  const q = question.trim().slice(0, 500);
  if (!q) return { ok: false, error: "Type a question first." };
  const c = await canvasCtx(user);
  const ids = new Set(itemIds);
  const ms = new Set(meetingIds);
  const byId = new Map(c.meetings.map((m) => [m.id, m]));
  const picked = c.items.filter((i) => i.status !== "wrong" && (ids.has(i.id) || ms.has(i.meetingId)));
  if (!picked.length) return { ok: false, error: "Nothing is plugged in. Turn on at least one card." };
  const raw: ItemSource[] = picked.map((i, k) => ({
    n: k + 1, itemId: i.id, kind: i.kind, status: i.status, text: i.text, person: i.person, quote: i.quote,
    closeQuote: i.closeQuote, dueAt: i.dueAt, meetingTitle: byId.get(i.meetingId)?.title ?? "a meeting", at: byId.get(i.meetingId)?.startedAt ?? i.createdAt,
  }));
  const sources = fitSources(raw, user.timeZone).map((s, k) => ({ ...s, n: k + 1 }));
  const ai = await canvasAi();
  if ("error" in ai) return { ok: false, error: ai.error };
  try {
    const r = await ai.client.messages.create({
      model: ai.model, max_tokens: 1500, system: ASK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildAskMessage(q, sources, { userName: user.name, timeZone: user.timeZone, now: c.now }) }],
    });
    return { ok: true, text: textOf(r as never), sources: sources.map((s) => ({ n: s.n, itemId: s.itemId, title: s.text })), via: ai.via };
  } catch (e) {
    return { ok: false, error: canvasError(ai.provider, e) };
  }
}

export type StartKind = CanvasWindow["kind"];

/** Opens a window for an item: a Claude draft, Claude Code in Terminal, or a Slack or email draft. */
export async function canvasStart(itemId: string, kind: StartKind): Promise<{ ok: boolean; error?: string; url?: string }> {
  const user = await me();
  if (!user) return { ok: false, error: "Finish setup first." };
  const c = await canvasCtx(user);
  const item = c.items.find((i) => i.id === itemId);
  if (!item) return { ok: false, error: "That item is gone." };
  const ctx = startContext(item, c, user.name);
  const w: CanvasWindow = { id: randomUUID(), itemId, kind, title: "", status: "running", output: "", createdAt: new Date().toISOString() };
  const done = (patch: Partial<CanvasWindow>) => { saveWindow({ ...w, ...patch }); revalidatePath(`/canvas/start/${itemId}`); };

  if (kind === "claude-code") {
    w.title = "Claude Code · Terminal";
    const err = await openInClaudeCode(w.id, `${ctx}\n\nHelp me get this done. Ask before assuming facts that aren't here.`);
    done(err ? { status: "error", output: err } : { status: "ready", output: "Opened in Terminal with this context. Mark it done here when the work is finished." });
    if (!err) await recordHandoff(itemId, "claude", "open");
    return { ok: !err, error: err ?? undefined };
  }
  if (kind === "slack" || kind === "email") {
    if (item.kind === "decision") return { ok: false, error: "Decisions don't need a message." };
    w.title = kind === "slack" ? "Slack draft" : "Email draft";
    const d = await draftsFor(itemId);
    if (!d.ok) { done({ status: "error", output: d.error }); return { ok: false, error: d.error }; }
    done({ status: "ready", output: kind === "slack" ? d.drafts.slack : `Subject: ${d.drafts.emailSubject}\n\n${d.drafts.emailBody}` });
    return { ok: true };
  }
  w.title = "Claude";
  const ai = await canvasAi();
  if ("error" in ai) {
    // No AI here: hand the context to claude.ai instead.
    done({ status: "ready", output: "No AI is set up on this Mac, so this opens in claude.ai with the context filled in." });
    return { ok: true, url: claudeUrl(ctx) };
  }
  saveWindow({ ...w, title: `AI · ${ai.via}` });
  try {
    const r = await ai.client.messages.create({ model: ai.model, max_tokens: 2000, system: WINDOW_SYSTEM, messages: [{ role: "user", content: ctx }] });
    done({ title: `AI · ${ai.via}`, status: "ready", output: textOf(r as never) || "Claude didn't write anything." });
    await recordHandoff(itemId, "claude", "open");
    return { ok: true };
  } catch (e) {
    const msg = canvasError(ai.provider, e);
    done({ status: "error", output: msg });
    return { ok: false, error: msg };
  }
}

/** Marks a window done, and closes its item unless told not to. */
export async function canvasFinish(windowId: string, closeItem: boolean): Promise<void> {
  const w = getWindow(windowId);
  if (!w) return;
  saveWindow({ ...w, status: "done" });
  if (closeItem) await getStore().setItemStatus(w.itemId, "done", new Date().toISOString());
  revalidatePath(`/canvas/start/${w.itemId}`);
}

export async function canvasResolve(contradictionId: string, how: "keep" | "replace"): Promise<void> {
  const user = await me();
  if (!user) return;
  await resolveContradiction(user, contradictionId, how);
  revalidatePath("/canvas", "layout");
}

/** Moves an item to next week: hidden until Monday 9 AM. */
export async function canvasNextWeek(itemId: string): Promise<void> {
  const user = await me();
  if (!user) return;
  const today = localDate(new Date(), user.timeZone);
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
  const monday = addDays(today, ((8 - dow) % 7) || 7);
  await getStore().updateItem(itemId, { snoozedUntil: zonedTime(monday, "09:00", user.timeZone).toISOString() });
  revalidatePath("/canvas", "layout");
}

export async function canvasDone(itemId: string): Promise<void> {
  const user = await me();
  if (!user) return;
  await getStore().setItemStatus(itemId, "done", new Date().toISOString());
  revalidatePath("/canvas", "layout");
}
