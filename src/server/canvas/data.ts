// Loads what the canvas views need, and keeps the canvas's own small state (windows) in
// <data>/canvas.json. The canvas adds nothing to the main store.
import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { findClaudeBinary } from "@/lib/claude-plan/client";
import { classifyProviderError } from "@/lib/ai/errors";
import type { ProviderId } from "@/lib/ai/providers";
import { clientForTask, messageFor, noteProblem, resolveTask } from "@/server/ai-config";
import type { Ctx } from "@/lib/canvas/build";
import type { CanvasWindow } from "@/lib/canvas/model";
import type { User } from "@/lib/types";
import { loadAll } from "@/app/_lib/lines";
import { aiClient } from "@/server/ai";
import { dataDir } from "@/server/local/paths";
import { readJson, writeJson } from "@/server/local/json-file";

export async function canvasCtx(user: User, now = new Date()): Promise<Ctx> {
  const { items, meetings } = await loadAll(user);
  return { items, meetings, self: [user.name, ...user.aliases], timeZone: user.timeZone, now };
}

// ---------- windows ----------

interface CanvasState { windows: CanvasWindow[] }
const statePath = () => join(dataDir(), "canvas.json");
const read = (): CanvasState => readJson<CanvasState>(statePath(), { windows: [] });

export function windowsFor(itemId: string): CanvasWindow[] {
  return read().windows.filter((w) => w.itemId === itemId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Item ids with a window still open, for "2 windows running" hints. */
export function openWindowCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of read().windows) if (w.status !== "done") out.set(w.itemId, (out.get(w.itemId) ?? 0) + 1);
  return out;
}

export function saveWindow(w: CanvasWindow): void {
  const s = read();
  const at = s.windows.findIndex((x) => x.id === w.id);
  if (at >= 0) s.windows[at] = w; else s.windows.push(w);
  s.windows = s.windows.slice(-300);
  writeJson(statePath(), s);
}

export function getWindow(id: string): CanvasWindow | null {
  return read().windows.find((w) => w.id === id) ?? null;
}

// ---------- AI ----------

/**
 * The client for canvas AI: the provider and model picked for Canvas in Settings › AI. With nothing
 * picked, the Anthropic key, or without one your Claude plan through Claude Code when it's installed
 * (local app only; see resolveTask). `via` names it on the canvas. Null, with a reason, when it
 * isn't set up.
 */
export async function canvasAi(): Promise<{ client: Pick<Anthropic, "messages">; model: string; via: string; provider: ProviderId } | { error: string }> {
  const t = resolveTask("canvas");
  if (t.provider === "anthropic") {
    const c = aiClient();
    return c ? { client: c, model: t.model, via: "your Anthropic API key", provider: t.provider } : { error: "No AI is set up. Pick one for Canvas in Settings › AI, add an Anthropic key, or sign in to Claude Code." };
  }
  const r = await clientForTask("canvas");
  if (!r.ok) return { error: r.error };
  return { client: r.client as unknown as Pick<Anthropic, "messages">, model: t.qualified, via: t.provider === "claude-plan" ? "your Claude plan" : `${t.label} · ${t.model}`, provider: t.provider };
}

/** A failure worded for the provider that Canvas used, recorded against it like any other job. */
export function canvasError(provider: ProviderId, e: unknown): string {
  const kind = classifyProviderError(e);
  if (provider !== "anthropic" && (kind === "auth" || kind === "credit")) noteProblem(provider, kind);
  return messageFor(provider, kind);
}

export const WINDOW_SYSTEM = `You help a busy person get one item from their meetings done. You get the item, the exact words from the meeting, what was decided and what else is open with the same person.
Do the work, not a plan for it: if it's a message, write the message; if it's a document or a ticket, write a first version; if it's a decision to make, lay out the options and recommend one.
Keep it short and plain, in their voice. Don't invent facts that aren't in the context; list what you'd need from them at the end, in one short list, only if something is missing.`;

/** Opens Terminal (macOS) with Claude Code started on the context. Resolves with an error message or null. */
export function openInClaudeCode(id: string, prompt: string): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve("Opening Claude Code in Terminal works on a Mac only. Copy the context instead.");
  const bin = findClaudeBinary();
  if (!bin) return Promise.resolve("Claude Code isn't installed. Install it from claude.com/claude-code, then try again.");
  const dir = join(dataDir(), "canvas");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id.replace(/[^a-z0-9-]/gi, "")}.md`);
  writeFileSync(file, prompt, { mode: 0o600 });
  // Paths are ours (data dir and a cleaned id), and quoted for the shell inside AppleScript.
  const sh = `cd ~ && ${JSON.stringify(bin)} "$(cat ${JSON.stringify(file)})"`;
  const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(sh)}\nend tell`;
  return new Promise((resolve) => execFile("osascript", ["-e", script], (e) => resolve(e ? "Couldn't open Terminal." : null)));
}
