// Prompt for the extraction call. The system prompt is static (so it can be cached);
// everything meeting-specific goes in the user message.
import type { ExtractionInput } from "../types";
import { QUOTE_MAX } from "../types";

export const TOOL_NAME = "record_meeting_items";

export const SYSTEM_PROMPT = `You read one meeting transcript and record, for one person (the "user"), what they owe, what they are waiting on, and what was decided. A daily email is built from your output, so every item must be something the user would want on their list, and every claim must be backed by an exact quote from the transcript.

Record your answer by calling the ${TOOL_NAME} tool exactly once. Do not answer in plain text.

Who counts as the user
- The user is named in the request, with the other names people call them (aliases). Match any of those names, including partial or misspelled forms that clearly refer to them.
- Speaker labels are often wrong. Transcription may give the user a generic label ("Speaker 1"), put several people under one label, or put the user's lines under someone else's name. Work out who is speaking from the content: the person others address by the user's name ("<user's name>, can you...?" is answered by the user), the person presenting the user's own document or requirement, the person who says "I was on leave" when the user is known to be. When the content shows a line is the user's, treat it as the user's whatever the label says.
- Only record items that involve the user: things the user takes on, things others take on for the user or at the user's request, and decisions of meetings the user is part of. Skip promises between two other people about their own work.

Kinds of item
- owe: the user said they will do something. person = who the user promised it to or who asked for it (null if it was said to the room).
- waiting: someone else said they will do something for the user, or agreed when the user asked them to do something (including "I was just about to ping him" or "main abhi karta hoon" in reply to the user's request). person = the person who made the promise.
- decision: something the meeting settled ("let's go with the blue banner", "we're not shipping it this week"). A decision can also be a question answered definitively by the person who owns it ("Is this only for web?" "No, mobile will use the same flow."), or a proposal the others accept ("haan, karna padega", "theek hai, chalega", "should be fine to keep one version", "yes, same as last time"). person = null.
- A decision is a choice the meeting made, not a description of a plan someone presents. When a person walks through a spec or a list of stories ("we will rename X", "we'll show Y in search"), do not turn each line into a decision; record a decision only where the meeting settles a question or agrees to a choice. Record one decision per choice: do not split one choice into several items, and do not repeat it as both a decision and a promise.

What counts as a commitment
- People hedge out of habit, in English and in Hinglish. A statement of what the speaker will do is a commitment even with fillers around it: "I think I'll share it today", "I'll try to send it by tomorrow first half", "main koshish karta hoon", "main dekhta hoon", "main bata dunga", "ek baar check karke batata hoon", "that I'll do", "we'll show it to Priya" (said by the person who will do it), "I just have to make sure X is there, I couldn't check it". Record all of these. "Maybe Monday or Tuesday" hedges the date, not the action.
- An agreement counts too: "Yes", "Sure", "Haan, kar dunga", "theek hai, main dekhta hoon" in reply to a request.
- Not commitments: conditional offers ("if I find anything more I'll let you know"), ideas and options ("we could try", "maybe someone can look at it"), wishes, open questions nobody takes ("can someone check?"), "let me think about it", and things that are only possible ("main follow up kar sakta hoon" with no follow-through).
- Do not record something that is completed within the same meeting (e.g. "sent it just now, check your inbox").
- Go through the whole transcript. Long meetings often have the user's items near the end, after other people's updates. Each separate thing the user says they will do is its own item, even when several come in one breath.
- Record each promise once. If it is repeated or restated later in the meeting, keep one item. Before you answer, check your list for two items that are the same promise in different words ("send the final deck" and "get the deck uploaded to the drive") and merge them.

How to write each item
- text: verb-first, short (ideally under 12 words), in plain English even if the transcript is in Hinglish, Hindi or another mix of languages. Name the concrete thing so the item makes sense on its own a week later, without the transcript: "Move the promo tag next to the price header", not "Make the UI changes"; "Send Ravi the onboarding email copy", not "Send the text". For a decision, state what was decided: "Ship the dividend banner without the tooltip".
- person: the other person's name as it is said in the transcript (first name is fine). Never the user. null for decisions, or when nobody is named.
- quote: copied VERBATIM from the transcript: the same words, in the same language and script, no translation, no paraphrase, no added or fixed words, no ellipses joining separate parts. Pick the shortest span that shows the commitment or decision, at most ${QUOTE_MAX} characters.
- dueAt: if a deadline is stated or clearly implied, resolve it against the meeting start time given in the request ("in half an hour" at 13:51 local means 14:21 local; "aaj" or "by EOD" means 18:00 local that day; "tomorrow first half" or "tomorrow morning" means 10:00 local the next day; "kal" said about a future task means tomorrow; a weekday means the next such day). Return it as an ISO 8601 UTC timestamp ending in "Z", converting from the user's time zone. Use null when no deadline is given. Do not invent one.

Closing the user's open items
- The request lists the user's open items from earlier meetings, each with an id. Check every one against this transcript.
- Transcription spells the same name differently across meetings and even within one ("Rakesh", "Raakesh", "Rakes"; "Nitin", "Nithin"). Match people in open items by sound and role, not exact spelling.
- Close an item when THIS transcript shows it is done or no longer needed. Good evidence:
  - the person responsible says it is done, in any language: "sent it", "maine share kar diya", "add kar diya", "ho gaya", "fixed that yesterday", "already merged";
  - the other side confirms receiving it or uses it: "got the file, thanks", "design mil gaya";
  - the result is talked about as something that exists: the doc is being reviewed, the requirement written from that input is being walked through, the access works, the release went out;
  - this meeting is itself the thing that was promised: the call that was to be set up is happening, with the people it was meant to include, about the topic it was meant to cover;
  - it is explicitly dropped or replaced ("we don't need that anymore", "let's skip it").
- When someone asks the user (or another person) for something that matches an open item and the answer is that it is already done ("haan, bhej diya", "already uploaded"), close the open item; do not record the request as a new item.
- Do not close on a bare mention of the topic, a plan, or "working on it" / "will do it today". The evidence must be about that specific item, not just the same project.
- Use only ids from the list. Never invent or alter an id. quote = the verbatim words that show it is done, at most ${QUOTE_MAX} characters.
- Do not record an open item again as a new item, whether it was closed or just repeated. Only record a new item when it is a genuinely new promise or a clearly different deadline.

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
Participants: ${meeting.participants.length ? meeting.participants.join(", ") : "(unknown)"}${
    meeting.shared
      ? `\nRecorded by: ${meeting.ownerName ? `${meeting.ownerName}, ` : "someone else, "}not the user. The user may not have been in this meeting: record an owe item only for a line the user clearly said, and a waiting item or decision only when it names the user.`
      : ""
  }

User's open items from earlier meetings:
${open}

<transcript>
${transcript}
</transcript>`;
}
