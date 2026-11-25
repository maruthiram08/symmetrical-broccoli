# Extraction eval

Runs the real extraction call (`src/lib/extract/extract.ts`) on saved meeting transcripts and scores the output against hand-written expected items.

```bash
npm run eval                  # all fixtures
npm run eval -- dividend      # only fixtures whose file name contains "dividend"
npm run eval -- --verbose     # also print matched items and items dropped by quote checks
```

It reads `ANTHROPIC_API_KEY` and `EXTRACTION_MODEL` (default `claude-sonnet-5-5`) from the environment, `.env` or `.env.local`. Each run makes one API call per fixture and prints the token count and an approximate ₹ cost (prices are placeholders in `src/lib/extract/cost.ts`).

The process exits with 1 when precision or recall is below 90% or a fixture errors, and with 2 when there are no fixtures.

## Fixtures are private

Fixtures are real meeting transcripts. `eval/fixtures/.gitignore` ignores `*.json`, so they stay on your machine. Only `example.json.sample` (synthetic) is committed. Don't rename a fixture to another extension to commit it.

## Adding a fixture

1. Copy the sample: `cp eval/fixtures/example.json.sample eval/fixtures/01-standup.json`. Name files with a number prefix so they run in meeting order.
2. Fill in:
   - `meeting`: `title`, `startedAt` (ISO UTC, e.g. 11:00 IST is `05:30Z`), `participants`.
   - `user`: `name`, `aliases` (every name people use for them), `timeZone`.
   - `transcript`: the Wispr Flow transcript text exactly as the app will receive it (speaker labels and all; don't clean it up).
   - `openItems`: the user's items still open before this meeting, each `{id, kind, text, person}`. Ids are any stable strings you choose, e.g. `standup-1`. To test auto-closing, put an item from an earlier fixture here.
   - `expected.newItems`: what a careful human would put on the list: `{kind, text, person}`. `kind` is `owe`, `waiting` or `decision`; `person` is `null` for decisions. Write `text` verb-first in English.
   - `expected.closes`: ids from `openItems` this meeting clearly finishes.
3. Run `npm run eval -- 01-standup --verbose` and read the misses and extras. Fix the fixture if the expected list was wrong; fix the prompt if the model was wrong.

### The first four fixtures

The first fixtures are Maruthi's meetings on 25 Nov 2026 (times in IST):

| File | Meeting | Start (IST) | `startedAt` (UTC) |
|---|---|---|---|
| `01-standup.json` | Standup | 11:00 | `2026-11-25T05:30:00.000Z` |
| `02-dividend-banner.json` | Dividend banner with Nitin | 13:51 | `2026-11-25T08:21:00.000Z` |
| `03-dividend-implementation.json` | Dividend implementation | 16:35 | `2026-11-25T11:05:00.000Z` |
| `04-corporate-actions-config.json` | Corporate actions config | 18:10 | `2026-11-25T12:40:00.000Z` |

Carry items forward: the open items of `02` are the expected items of `01` that were still open (with ids you assign), and so on, so the later meetings test closing.

## How scoring works

See `eval/score.ts` (unit-tested in `eval/score.test.ts`).

- An actual item matches an expected one when the `kind` is the same, the `person` matches loosely (case-insensitive, first name, or one letter off; not checked for decisions), and the text is similar: content-token overlap (Dice) of at least 0.5, or the expected text's key noun (its longest word that isn't a generic verb or the person's name) appears in the actual text.
- Matching is one-to-one. Unmatched expected items are **missed**; unmatched actual items are **wrong**.
- Closes are compared by id: **wrong closes** were closed but shouldn't be, **missed closes** should have been closed.
- Precision and recall are computed over items and closes together. Both must be at least 90%.
