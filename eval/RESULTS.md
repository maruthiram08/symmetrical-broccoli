# Extraction eval results (25 Nov 2026)

Model `claude-sonnet-5-5` (default effort), one call per meeting. All numbers come from `npm run eval`, and every run is scored with the final labels and the final scorer (`--rescore` on the saved runs), so the columns compare like with like.

## Meetings used

Eight of Maruthi's own meetings (none shared), all with transcripts. Most are Hinglish; two also have long side conversations in Telugu.

| # | Meeting | Date (IST) |
|---|---|---|
| 01 | Info Icon Split Tag Update | 17 Nov 2026, 10:48 |
| 02 | Product Feature Updates and Categorization | 19 Nov 2026, 16:30 |
| 03 | Front-End Team Structure Overview | 20 Nov 2026, 13:18 |
| 04 | Price Alerts Feature Requests | 20 Nov 2026, 18:40 |
| 05 | Place Order V2 Review (daily standup) | 25 Nov 2026, 11:00 |
| 06 | Dividend and Stock Action Banner | 25 Nov 2026, 13:51 |
| 07 | Dividend Corporate Action Implementation | 25 Nov 2026, 16:35 |
| 08 | Corporate Actions Configuration Plan | 25 Nov 2026, 18:10 |

Labels: 38 required items (25 owe or waiting, 13 decisions) and 3 required closes. There are also optional items and closes for borderline cases, which count neither for nor against. Open items carry forward across meetings, so the last meeting is checked against 26 open items from the earlier seven. That tests closing across meetings, and also checks that unrelated items are not closed by mistake. One person (Claude) wrote the labels after reading each transcript in full. Speaker labels in these transcripts are often wrong, so some attributions are judgement calls.

## Before and after

| | Baseline prompt | Run 1 | Run 2 | Run 3 | Final prompt (run 4) |
|---|---|---|---|---|---|
| Items precision | 95.5% | 96.9% | 78.6% | 88.9% | **93.9%** |
| Items recall | 55.3% | 81.6% | 86.8% | 84.2% | **81.6%** |
| Closes precision | 100% (1/1) | 100% | 100% | 100% | **100% (2/2)** |
| Closes recall | 33.3% (1/3) | 33.3% | 66.7% | 66.7% | **66.7% (2/3)** |
| Overall P / R | 95.7% / 53.7% | 97.0% / 78.0% | 79.5% / 85.4% | 89.5% / 82.9% | **94.3% / 80.5%** |
| Cost | ₹23.45 | ₹28.29 | ₹28.13 | ₹28.72 | ₹28.55 |

Total API spend for the evaluation was about ₹137 (placeholder prices in `src/lib/extract/cost.ts`: $2/$10 per MTok, ₹88/$). The new prompt costs about ₹0.6 more per meeting (₹3.57 against ₹2.93), almost all from more output.

The eval still fails its 90% recall threshold.

## Main error patterns and what changed

All changes are in `src/lib/extract/prompt.ts`. Nothing changed in the extract code.

1. **The user's own commitments were missed when they were hedged or in Hinglish.** This was by far the biggest pattern. The user often wraps a clear "I will do X" in fillers ("I think", "I'll try", a hedged date), and the old rule "skip maybes" made the model drop these. The prompt now separates fillers from real non-commitments: ideas, options, open questions, "could do", and conditional offers. It gives generic English and Hinglish examples.
2. **Wrong or missing speakers.** Diarization puts the user under a generic label or under another person's name, and merges people. The prompt now says to find the user from content: the person others address by the user's name, or the one presenting the user's own document. It should treat those lines as the user's whatever the label says.
3. **Missed waiting items** where the other side agreed informally to the user's request (for example, by saying they were about to do it). These now count.
4. **Missed decisions** that came as a definitive answer to a question or as a short Hinglish agreement. Asking for more decisions caused over-extraction in run 2: precision fell to 79%, with spec lines read out in a presentation turned into "decisions" and one choice split into several. Run 3 added a rule: a decision is a choice the meeting made, not a line of a presented plan, and each choice is one item, not repeated as a promise.
5. **Vague items** (a generic "make the changes and share an update"). The prompt now asks for text that names the concrete thing and makes sense a week later.
6. **Repeated items.** The same promise was recorded twice in different words. The prompt now asks the model to check its list for this and merge before answering.
7. **Missed closes.** Three causes:
   - The same colleague's name is spelled differently across meetings, so open items didn't match. The prompt now says to match names by sound and role.
   - The meeting itself was the promised call, but the model didn't treat that as evidence. That is now listed as evidence.
   - A request was answered "already done" but recorded as a new item instead of closing the open one. There is now an explicit rule for this.

   There were no wrong closes in any run.

After the final run, the example names and phrases in the prompt were made generic, so the prompt holds no names or wording from these meetings. Only example text changed, and the eval was not re-run after it.

## Eval harness changes

- The fixture `person` can be a list of acceptable names, with `null` allowed.
- New optional fields: `expected.optionalItems` and `expected.optionalCloses`.
- Close ids are checked against `openItems`.
- Precision and recall are reported separately for items and closes.
- Matching takes the best pairs first. Before, a loose key-noun match on an early expected item could take an actual item that fitted a later one better.
- Light stemming (-ing, -ed, -ation) and hyphen joining.
- Each run saves its output to `eval/fixtures/last-run.out.json` (gitignored), and `--rescore` re-scores a saved run without API calls.

## Known weaknesses

- **Small sample, one annotator, noisy runs.** 41 required labels and one run per prompt version. Precision moved about 10 points between runs 2 and 3, partly from the prompt and partly from sampling. Treat differences of a few points as noise.
- **Closes are thinly tested.** Only 3 required closes, because promises across these days rarely came back up in a later meeting. The final run missed one: a later meeting used a colleague's earlier input without saying it was done. Wrong-close resistance is better covered (26 open items, none closed wrongly in any run).
- **Decisions are the least stable kind.** The model still varies on which agreed points count as decisions; most remaining recall misses are decisions.
- **Attribution under bad diarization.** In the final run, one of the user's own promises was recorded as a waiting item from someone else.
- **Scorer leniency and strictness.** Text matching is token overlap plus a key noun. It can still miss a correct paraphrase or accept a loose one. Read `--verbose` output before trusting a single number.
- Cost per meeting rose about 20%.

## 26 Nov 2026: attribution and decisions (new labels)

Fixtures were rebuilt on Maruthi's Mac with fresh labels (34 required items, 3 required closes), so these numbers don't compare with the table above. Every score uses the fairer matcher (sound-alike names, phrasing lists).

| | Baseline prompt (2 reads) | Round 1 prompt, shipped (2 reads) | Round 2 prompt (1 read) |
|---|---|---|---|
| Overall precision | 87.1% / 88.6% | **96.4% / 96.7%** | 80.0% |
| Overall recall | 73.0% / 83.8% | 73.0% / 78.4% | 75.7% |
| Attribution | 91.3% / 100% | **100% / 100%** | 87.5% |
| Wrong closes | 1 / 1 | **0 / 0** | 1 |
| Closes caught (of 3) | 1 / 2 | 0 / 1 | 2 |

Round 1 ships: no wrong closes and every promise credited to the right person. A missed close leaves an item open for one more tap; a wrong close hides a real promise. Close recall is the next thing to improve. Total eval spend was ₹124.
