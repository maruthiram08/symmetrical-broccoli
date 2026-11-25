# Extraction eval

Runs the real extraction call (`src/lib/extract/extract.ts`) on saved meeting transcripts and scores the output against hand-written expected items.

```bash
npm run eval                  # all fixtures
npm run eval -- dividend      # only fixtures whose file name contains "dividend"
npm run eval -- --verbose     # also print matched items and items dropped by quote checks
npm run eval -- --rescore     # re-score the last run against the current fixtures, no API calls
npm run eval -- --rescore=run1.out.json   # re-score a saved run (a file in eval/fixtures/)
```

Each live run saves the full model output to `eval/fixtures/last-run.out.json` (gitignored, like the fixtures, because it holds transcript quotes). Copy it to another `*.out.json` name to keep it; `--rescore` lets you fix a label and see the effect without paying for another run.

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
   - `expected.newItems`: what a careful human would put on the list: `{kind, text, person}`. `kind` is `owe`, `waiting` or `decision`; `person` is `null` for decisions. Write `text` verb-first in English. When more than one person is a fair answer (the asker, or the person it's done with), give a list: `"person": ["Asha", "Ravi"]`; put `null` in the list when "no person" is also fine.
   - `expected.closes`: ids from `openItems` this meeting clearly finishes.
   - `expected.optionalItems` (optional): items a careful human might or might not list, in the same shape. An actual item that matches one is neither a hit nor wrong. Use it for borderline items, so the score measures clear cases.
   - `expected.optionalCloses` (optional): open item ids where closing is defensible but not required.
3. Run `npm run eval -- 01-standup --verbose` and read the misses and extras. Fix the fixture if the expected list was wrong; fix the prompt if the model was wrong.

### Current fixtures

Eight of Maruthi's own meetings (times in IST). Open items carry forward: each fixture's `openItems` are the expected owe/waiting items of the earlier fixtures that are still open, with ids like `m07-figma`, so later meetings test closing (and not closing) across meetings.

| File | Meeting | Start (IST) |
|---|---|---|
| `01-info-icon-split-tag.json` | Info Icon Split Tag Update | 17 Nov 10:48 |
| `02-product-feature-updates.json` | Product Feature Updates and Categorization | 19 Nov 16:30 |
| `03-frontend-team-structure.json` | Front-End Team Structure Overview | 20 Nov 13:18 |
| `04-price-alerts.json` | Price Alerts Feature Requests | 20 Nov 18:40 |
| `05-standup.json` | Place Order V2 Review (standup) | 25 Nov 11:00 |
| `06-dividend-banner.json` | Dividend and Stock Action Banner | 25 Nov 13:51 |
| `07-dividend-implementation.json` | Dividend Corporate Action Implementation | 25 Nov 16:35 |
| `08-corporate-actions-config.json` | Corporate Actions Configuration Plan | 25 Nov 18:10 |

Results and the error analysis are in `eval/RESULTS.md`.

## How scoring works

See `eval/score.ts` (unit-tested in `eval/score.test.ts`).

- An actual item matches an expected one when the `kind` is the same, the `person` matches loosely (case-insensitive, first name, or one letter off; not checked for decisions), and the text is similar: content-token overlap (Dice) of at least 0.5, or the expected text's key noun (its longest word that isn't a generic verb or the person's name) appears in the actual text.
- Text tokens drop stopwords, join hyphenated words ("front-end" = "frontend") and strip simple endings (-s, -ies, -ing, -ed, -ation).
- Matching is one-to-one, best pairs first: all matching (expected, actual) pairs are ranked by overlap and taken greedily, with required and optional items in one ranking. Unmatched required items are **missed**; actual items matching nothing are **wrong**; matches to optional items are not counted.
- Closes are compared by id: **wrong closes** were closed but shouldn't be (and aren't optional), **missed closes** should have been closed.
- Precision and recall are computed over items and closes together; both must be at least 90%. They are also printed separately for items and for closes.
