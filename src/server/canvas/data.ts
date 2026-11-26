// Loads what the canvas views need, and keeps the canvas's own small state (windows) in
// <data>/canvas.json. The canvas adds nothing to the main store.
import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";
import { claudePlanClient, findClaudeBinary } from "@/lib/claude-plan/client";
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
 * The client for canvas AI: your Claude plan through Claude Code when it's installed, otherwise the
 * Anthropic API key from Settings. Null when there is neither.
 */
export function canvasAi(): { client: Pick<Anthropic, "messages">; model: string; via: "plan" | "key" } | null {
  if (process.env.DAILY_BRIEF_CANVAS_AI !== "key" && findClaudeBinary()) return { client: claudePlanClient() as unknown as Pick<Anthropic, "messages">, model: "sonnet", via: "plan" };
  const c = aiClient();
  return c ? { client: c, model: env.extractionModel, via: "key" } : null;
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
