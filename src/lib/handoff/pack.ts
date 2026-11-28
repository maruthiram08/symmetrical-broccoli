// The Claude context pack: a prompt the user pastes into (or opens in) Claude to get the work started.
import { dueWording, meetingLabel } from "./format";
import type { HandoffContext } from "./types";

export function contextPack(ctx: HandoffContext): string {
  const who = ctx.item.person ?? "someone (no name recorded)";
  const owe = ctx.item.kind === "owe";
  const lines: string[] = [];
  lines.push(`I'm ${ctx.user.name}. This came out of one of my meetings and I want to get it moving.`);
  lines.push("");
  lines.push(`${owe ? "What I owe" : "What I'm waiting on"}: ${ctx.item.text}`);
  lines.push(owe ? `Owed to: ${who}` : `Waiting on: ${who}`);
  const due = dueWording(ctx);
  if (due) lines.push(`Deadline: ${due}`);
  const m = meetingLabel(ctx);
  if (m) lines.push(`Meeting: ${m}`);
  lines.push(`Exact words from the meeting: "${ctx.item.quote}"`);
  const open = ctx.related.filter((r) => r.status === "open");
  if (open.length && ctx.item.person) {
    lines.push("");
    lines.push(`Other open items with ${ctx.item.person}:`);
    for (const r of open) lines.push(`- ${r.kind === "owe" ? "I owe" : "Waiting on them"}: ${r.text}${r.meetingTitle ? ` (${r.meetingTitle})` : ""}`);
  }
  lines.push("");
  lines.push(
    owe
      ? "Help me get this done: work out what the deliverable is, draft it (or a first version), and list anything you need from me. If it is a message, keep it short and plain, in my voice."
      : `Help me follow up: draft a short, polite nudge to ${ctx.item.person ?? "them"} in my voice, and suggest what to do if there's still no reply in a day or two.`,
  );
  lines.push("Ask me before assuming facts that aren't here. Don't send anything on my behalf.");
  return lines.join("\n");
}
