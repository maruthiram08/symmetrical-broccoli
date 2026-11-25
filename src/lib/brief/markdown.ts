import type { BriefLine, BriefModel } from "@/lib/types";
import { renderWrapSection } from "./wrap";

/** The daily note saved as YYYY-MM-DD.md. Plain Markdown that any editor (and the v1.1 desktop app) can open. */
export function renderMarkdown(m: BriefModel): string {
  const out: string[] = [];
  out.push("---", `date: ${m.date}`, `meetings: ${m.wrap.meetings}`, `promises_made: ${m.wrap.made}`, `kept: ${m.wrap.kept}`, `late: ${m.wrap.late}`, "---", "");
  out.push(`# ${m.dateLabel}`, "");
  out.push(m.meetingCount ? `From ${m.meetingCount} meeting${m.meetingCount === 1 ? "" : "s"} today.` : "No meetings today.", "");
  if (m.empty === "nothing_owed") out.push("**Nothing owed. Go home.**", "");

  section(out, "You owe", m.youOwe);
  section(out, "Waiting on", m.waitingOn);
  section(out, "Decisions", m.decisions);

  if (m.closedToday.length) {
    out.push("## Closed today", "");
    for (const c of m.closedToday) out.push(`- [x] ~~${esc(c.text)}~~`, `  Closed: "${esc(c.closeQuote)}" in ${esc(c.closedInMeeting)}, ${c.closedAtTime}`);
    out.push("");
  }
  if (m.stillOpenCount) {
    out.push(`## Still open from before (${m.stillOpenCount})`, "");
    for (const l of m.stillOpen) out.push(...line(l));
    if (m.stillOpenCount > m.stillOpen.length) out.push(`- …and ${m.stillOpenCount - m.stillOpen.length} more`);
    out.push("");
  }
  out.push(...renderWrapSection(m.wrap, m.openPromises));
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Lines appended to decisions.md for this brief's decisions. */
export function renderDecisionsAppend(m: BriefModel): string {
  return m.decisions.map((d) => `- ${m.date} · ${esc(d.text)} — "${esc(d.quote)}" (${esc(d.meetingTitle)}, ${d.meetingTime})`).join("\n") + (m.decisions.length ? "\n" : "");
}

function section(out: string[], title: string, lines: BriefLine[]) {
  if (!lines.length) return;
  out.push(`## ${title}`, "");
  for (const l of lines) out.push(...line(l));
  out.push("");
}

function line(l: BriefLine): string[] {
  const box = l.kind === "decision" ? "-" : "- [ ]";
  const when = l.lateLabel ? ` **(${l.lateLabel})**` : l.dueLabel ? ` (${l.dueLabel})` : "";
  return [`${box} ${esc(l.text)}${when}`, `  "${esc(l.quote)}" · ${esc(l.meetingTitle)}, ${l.meetingTime}`];
}

/** Keep transcript text from turning into Markdown structure. */
export function esc(s: string): string {
  return s.replace(/\r?\n+/g, " ").replace(/([\\`*_[\]<>#|~])/g, "\\$1");
}
