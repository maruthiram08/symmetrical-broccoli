// Non-AI drafts. Used when the Claude call fails or its output does not pass validation.
import { clip, firstName, lowerFirst, shortDate } from "./format";
import type { HandoffContext, MessageDraft } from "./types";

export function templateDraft(ctx: HandoffContext): MessageDraft {
  const name = firstName(ctx.item.person);
  const hi = name ? `Hi ${name},` : "Hi,";
  const task = lowerFirst(ctx.item.text.trim().replace(/[.!]+$/, ""));
  const where = ctx.meeting
    ? ` from ${ctx.meeting.title} on ${shortDate(ctx.meeting.startedAt, ctx.user.timeZone)}`
    : "";
  const quote = clip(ctx.item.quote, 120);
  const sign = firstName(ctx.user.name) ?? ctx.user.name;

  if (ctx.item.kind === "waiting") {
    const what = quote ? `: "${quote}"` : `: ${ctx.item.text.trim().replace(/[.!]+$/, "")}`; // items you added have no quote
    const slack = `${hi} quick nudge on this${where}${what}. Any update on when it'll be done?`;
    return {
      slack,
      emailSubject: clip(`Following up: ${ctx.item.text}`, 80),
      emailBody: `${hi}\n\nFollowing up on this${where}${what}.\n\nAny update on when it'll be done? Let me know if you need anything from me.\n\nThanks,\n${sign}`,
    };
  }
  const slack = `${hi} update on ${task}${where}. I'm on it and will share it shortly. Let me know if anything has changed on your side.`;
  return {
    slack,
    emailSubject: clip(`Update: ${ctx.item.text}`, 80),
    emailBody: `${hi}\n\nQuick update on ${task}${where}. I'm on it and will share it shortly.\n\nLet me know if anything has changed on your side.\n\nThanks,\n${sign}`,
  };
}
