// Your note templates, kept per workspace in <notes>/.daily-brief/templates/<kind>.md.
// No file means the default (which writes the notes exactly as before templates existed).

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { templateProblem } from "@/lib/templates/engine";
import { TEMPLATE_INFO, type TemplateKind } from "@/lib/templates/kinds";
import { writeAtomic } from "./atomic";
import type { Workspace } from "./workspaces";

export const MAX_TEMPLATE_CHARS = 50_000;

export function templatePath(ws: Pick<Workspace, "path">, kind: TemplateKind): string {
  return join(ws.path, ".daily-brief", "templates", `${kind}.md`);
}

/** Your template, or null for the default. */
export function loadTemplate(ws: Pick<Workspace, "path">, kind: TemplateKind): string | null {
  const p = templatePath(ws, kind);
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

/** Save a template. A broken one is refused with the reason; the default itself removes the file. */
export function saveTemplate(ws: Pick<Workspace, "path">, kind: TemplateKind, text: string): { ok: true } | { ok: false; error: string } {
  const src = text.replace(/\r\n/g, "\n");
  if (src.length > MAX_TEMPLATE_CHARS) return { ok: false, error: "That template is too long." };
  if (!src.trim()) return { ok: false, error: "A template can't be empty. Use Reset to go back to the default." };
  const problem = templateProblem(src);
  if (problem) return { ok: false, error: problem };
  if (src === TEMPLATE_INFO[kind].defaults) return resetTemplate(ws, kind);
  writeAtomic(templatePath(ws, kind), src, 0o600);
  return { ok: true };
}

export function resetTemplate(ws: Pick<Workspace, "path">, kind: TemplateKind): { ok: true } {
  try { unlinkSync(templatePath(ws, kind)); } catch { /* already the default */ }
  return { ok: true };
}
