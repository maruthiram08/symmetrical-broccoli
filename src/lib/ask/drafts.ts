// Drafts in an Ask answer. When you ask Ask to write a message, the model puts the message itself
// between a ":::draft To <person> · <channel>" line and a ":::" line; the chat shows it as a card
// you can copy. Everything else in the answer stays ordinary text. Pure; works on a half-streamed
// answer too (an unclosed draft is shown as still being written).

export interface DraftPart { type: "draft"; to: string | null; via: string | null; body: string; done: boolean }
export type AnswerPart = { type: "text"; text: string } | DraftPart;

const OPEN = /^[ \t]*:::[ \t]*draft\b[ \t]*(.*)$/i;
const CLOSE = /^[ \t]*:::[ \t]*$/;

function head(rest: string): { to: string | null; via: string | null } {
  const r = rest.replace(/^[\s:–—-]+/, "").trim();
  if (!r) return { to: null, via: null };
  const [a, b] = r.split(/\s+[·|•]\s+|\s+-\s+(?=\S+$)/, 2).map((x) => x?.trim() || null);
  const to = a ? a.replace(/^to\s+/i, "").trim() || null : null;
  return { to, via: b ?? null };
}

export function splitDrafts(answer: string): AnswerPart[] {
  const out: AnswerPart[] = [];
  let text: string[] = [];
  let draft: { to: string | null; via: string | null; lines: string[] } | null = null;
  const flushText = () => { const t = text.join("\n"); if (t.trim()) out.push({ type: "text", text: t }); text = []; };
  for (const line of answer.split("\n")) {
    if (draft) {
      if (CLOSE.test(line)) { out.push({ type: "draft", to: draft.to, via: draft.via, body: draft.lines.join("\n").trim(), done: true }); draft = null; }
      else draft.lines.push(line);
      continue;
    }
    const m = OPEN.exec(line);
    if (m) { flushText(); draft = { ...head(m[1] ?? ""), lines: [] }; continue; }
    text.push(line);
  }
  if (draft) out.push({ type: "draft", to: draft.to, via: draft.via, body: draft.lines.join("\n").trim(), done: false });
  flushText();
  return out;
}

/** The handoff target a draft's channel maps to, for "Mark as started". */
export function draftTarget(via: string | null): "slack" | "email" {
  return via && /mail/i.test(via) ? "email" : "slack";
}
