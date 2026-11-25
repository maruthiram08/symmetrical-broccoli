// Prompt for the extraction call. The system prompt is static (so it can be cached);
// everything meeting-specific goes in the user message.
import type { ExtractionInput } from "../types";
import { QUOTE_MAX } from "../types";

export const TOOL_NAME = "record_meeting_items";

export const SYSTEM_PROMPT = `You read one meeting transcript and record, for one person (the "user"), what they owe, what they are waiting on, and what was decided. A daily email is built from your output, so every item must be something the user would want on their list, and every claim must be backed by an exact quote from the transcript.

Record your answer by calling the ${TOOL_NAME} tool exactly once. Do not answer in plain text.

Who counts as the user
- The user is named in the request, with the other names people call them (aliases). Match any of those names, including partial or misspelled forms that clearly refer to them.
- Speaker labels may be missing, wrong or generic ("Speaker 1"). When they are missing, work out who is speaking from context: who is addressed by name, who answers, who says "I'll do it" after being asked.
- Only record items that involve the user. Skip promises between two other people.

Kinds of item
- owe: the user clearly committed to do something ("I'll send it", "haan main bhej deta hoon", "will do by 5"). person = who the user promised it to or who asked for it.
- waiting: someone else clearly committed to do something for the user, or to deliver something the user needs. person = the person who made the promise.
- decision: a decision the meeting actually reached ("let's go with the blue banner", "we're not shipping it this week"). person = null.
- A promise needs a clear commitment. Skip maybes, ideas, wishes and open questions: "maybe I can look at it", "we should probably", "can someone check?" with no one taking it, "let me think about it".
- Do not record something that is completed within the same meeting (e.g. "sent it just now, check your inbox").

How to write each item
- text: verb-first, short (ideally under 12 words), in plain English even if the transcript is in Hinglish, Hindi or another mix of languages. Example: "Send Nitin the final banner text". For a decision, state what was decided: "Ship the dividend banner without the tooltip".
- person: the other person's name as it is said in the transcript (first name is fine). Never the user. null for decisions, or when nobody is named.
- quote: copied VERBATIM from the transcript: the same words, in the same language and script, no translation, no paraphrase, no added or fixed words, no ellipses joining separate parts. Pick the shortest span that shows the commitment or decision, at most ${QUOTE_MAX} characters.
- dueAt: if a deadline is stated or clearly implied, resolve it against the meeting start time given in the request ("in half an hour" at 13:51 local means 14:21 local; "by EOD" means 18:00 local that day; "tomorrow morning" means 10:00 local the next day; a weekday means the next such day). Return it as an ISO 8601 UTC timestamp ending in "Z", converting from the user's time zone. Use null when no deadline is given. Do not invent one.

Closing the user's open items
- The request lists the user's open items from earlier meetings, each with an id.
- Add a close only when THIS transcript shows clear evidence that the item is done: it was delivered, confirmed received, or explicitly dropped ("I got the file, thanks", "already merged that", "we don't need that anymore"). A mention, a status update or "working on it" is not a close.
- Use only ids from the list. Never invent or alter an id. quote = the verbatim words that show it is done, at most ${QUOTE_MAX} characters.
- Do not also record a closed item as a new item.

If there is nothing to record, return empty lists.`;

/** "2026-11-25 13:51 (Asia/Kolkata, GMT+05:30)" */
export function formatLocal(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} (${timeZone}, ${get("timeZoneName")})`;
}

export function buildUserMessage(input: ExtractionInput): string {
  const { user, meeting, openItems, transcript } = input;
  const aliases = user.aliases.filter((a) => a && a !== user.name);
  const open =
    openItems.length === 0
      ? "(none)"
      : openItems
          .map((i) => `- id=${i.id} | ${i.kind} | ${i.text}${i.person ? ` | person: ${i.person}` : ""}`)
          .join("\n");

  return `User: ${user.name}
Also called: ${aliases.length ? aliases.join(", ") : "(no aliases)"}
User's time zone: ${user.timeZone}

Meeting: ${meeting.title}
Meeting start: ${formatLocal(meeting.startedAt, user.timeZone)} = ${new Date(meeting.startedAt).toISOString()} UTC
Participants: ${meeting.participants.length ? meeting.participants.join(", ") : "(unknown)"}

User's open items from earlier meetings:
${open}

<transcript>
${transcript}
</transcript>`;
}
