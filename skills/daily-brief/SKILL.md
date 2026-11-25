---
name: daily-brief
description: Use the Daily brief MCP tools (today, list_open, person, search, decisions, mark_item) to answer questions about the user's meeting promises and decisions, prep for a meeting with someone, run a weekly review, or close items. Use whenever the user asks what they owe, who owes them, what was decided, or wants to get ready for a meeting.
---

# Daily brief

Daily brief reads the user's meetings (Wispr Flow) and keeps three kinds of items:

- **owe**: something the user promised someone ("You owe").
- **waiting**: something someone promised the user ("Waiting on").
- **decision**: something decided in a meeting.

Every item has an id in `[brackets]`, the person, the meeting it came from, its date, an optional due date, and the **verbatim quote** of what was said. Items close on their own when a later meeting shows they are done; those carry the closing quote.

The tools come from the `daily-brief` MCP server. They read the user's local file and never call any outside service.

## Tools

| Tool | Use it for |
|---|---|
| `today` | The Today screen: what's due today, decided today, closed today, and older things still open. Start here for "what's on my plate". |
| `list_open` | Everything still open. Filter by `kind` (owe, waiting, decision) and/or `person` (fuzzy). Overdue first. |
| `person` | Everything with one person: what the user owes them, what they owe the user, recent closes, decisions from meetings together. |
| `search` | Words in item text, quotes, people and meeting titles. Open items only unless `include_closed: true`. |
| `decisions` | Decisions by topic (`query`) and/or date (`since`, YYYY-MM-DD). |
| `mark_item` | Set an item to done, wrong or open. **Only when the user asks.** |

## Rules

- **Quote the evidence.** When you state that someone promised or decided something, give the quote and the meeting, briefly: *Tarun: "I'll send the deck by Friday" (Banner review, 20 Nov)*.
- **Don't invent.** If the tools return nothing, say so plainly ("I don't see that in your meetings") and suggest a different word or a person to look up. Never fill gaps from general knowledge.
- **Names are fuzzy.** If `person` says a name is ambiguous, ask which one, using the candidates it lists. If a first name finds nobody, try `search` with the name.
- **Search on content words.** `search` matches word starts and ranks phrases first; pass "dividend banner", not the whole question. Add `include_closed: true` when the user asks about the past or "did X ever…".
- **Change things only when asked.** Use `mark_item` only when the user says something is done, wrong, or should be reopened. Confirm with the item's text afterwards. Never mark items as a side effect of a review.
- **Dates**: speak the way people do ("tomorrow", "last Tuesday", "3 days late"); the tools already give due and late labels.
- **Nothing gets sent.** If the user wants to nudge someone, draft the message for them to send; Daily brief never sends messages.

## Recipes

### Prep for a meeting with someone

1. `person` with their name (`recent_days: 30`).
2. If the meeting has a topic, `search` for it and `decisions` with `query` set to the topic.
3. Answer in this order, short:
   - **You owe them**: open items, overdue first, each with its quote. These are the things to have ready or to give a status on.
   - **They owe you**: open items to ask about, with how late they are.
   - **Decided before**: the relevant decisions, newest first, so nobody re-decides them by accident.
   - **Closed recently**: one line, so the user can thank them or not chase it.
4. End with 1-3 suggested talking points drawn only from the above.

### Weekly review

1. `list_open` (no filter) for everything open.
2. `decisions` with `since` set to 7 days ago.
3. For the people with the most open items, `person` shows what closed with them recently.
4. Present:
   - **Overdue you owe**: the list to clear first.
   - **Overdue from others**: who to nudge; offer to draft short nudges.
   - **Due next week**.
   - **Decisions this week**: one line each with the meeting.
   - **Stale**: open items older than two weeks with no due date. Ask whether any are done or wrong; if the user says so, call `mark_item`.

### "What did we decide about X?"

`decisions` with `query: "X"`. If several decisions on the same topic disagree, show them newest first and point out that the later one may replace the earlier one. Don't pick one yourself.

### "What do I owe?" / "Who owes me?"

`list_open` with `kind: "owe"` or `kind: "waiting"`, optionally `person`. Group by person when there are more than five.

### Close things the user says are done

"I sent Tarun the deck": find it with `person` or `search`, then `mark_item` with the id and `status: "done"`. If more than one item fits, ask which. Report the change with the item's text.
