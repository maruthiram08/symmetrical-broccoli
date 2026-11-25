// npm run eval [-- <name filter>] [-- --verbose] [-- --rescore[=<file>]]
// Runs extractMeeting on every eval/fixtures/*.json with the real API and scores it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { extractMeeting, type PostProcessReport } from "../src/lib/extract/extract";
import { costInr } from "../src/lib/extract/cost";
import { env } from "../src/lib/env";
import type { ExtractionResult } from "../src/lib/types";
import { passes, scoreMeeting, THRESHOLD, totals, type MeetingScore } from "./score";

const ROOT = path.resolve(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");

for (const f of [".env", ".env.local"]) {
  const p = path.join(ROOT, f);
  if (existsSync(p)) process.loadEnvFile(p);
}

const Kind = z.enum(["owe", "waiting", "decision"]);
const ExpectedItemSchema = z.object({
  kind: Kind,
  text: z.string(),
  person: z.union([z.string(), z.null(), z.array(z.string().nullable()).min(1)]),
});
const FixtureSchema = z
  .object({
    meeting: z.object({ title: z.string(), startedAt: z.string(), participants: z.array(z.string()) }),
    user: z.object({ name: z.string(), aliases: z.array(z.string()), timeZone: z.string() }),
    transcript: z.string().min(1),
    openItems: z.array(z.object({ id: z.string(), kind: Kind, text: z.string(), person: z.string().nullable() })),
    expected: z.object({
      newItems: z.array(ExpectedItemSchema),
      closes: z.array(z.string()),
      optionalItems: z.array(ExpectedItemSchema).optional(),
      optionalCloses: z.array(z.string()).optional(),
    }),
  })
  .superRefine((f, ctx) => {
    const ids = new Set(f.openItems.map((i) => i.id));
    for (const id of [...f.expected.closes, ...(f.expected.optionalCloses ?? [])])
      if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["expected", "closes"], message: `unknown open item id "${id}"` });
  });
type Fixture = z.infer<typeof FixtureSchema>;

function loadFixtures(filter?: string): Array<{ name: string; fixture: Fixture }> {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".out.json"))
    .filter((f) => !filter || f.includes(filter))
    .sort()
    .map((f) => {
      const raw = JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
      const parsed = FixtureSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`Fixture ${f} is invalid: ${issues}`);
      }
      return { name: f.replace(/\.json$/, ""), fixture: parsed.data };
    });
}

const LAST_RUN = "last-run.out.json";
interface SavedRun {
  name: string;
  result: ExtractionResult;
  report: PostProcessReport;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const inr = (n: number) => `₹${n.toFixed(2)}`;

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const filter = args.find((a) => !a.startsWith("-"));
  // --rescore: score a saved run (default: the last one) against the current fixtures, with no API calls.
  const rescoreArg = args.find((a) => a === "--rescore" || a.startsWith("--rescore="));
  const saved = rescoreArg
    ? new Map(
        (JSON.parse(readFileSync(path.join(FIXTURES, rescoreArg.split("=")[1] ?? LAST_RUN), "utf8")) as SavedRun[]).map(
          (r) => [r.name, r],
        ),
      )
    : null;
  const fixtures = loadFixtures(filter);
  if (fixtures.length === 0) {
    console.error(`No fixtures in ${FIXTURES}${filter ? ` matching "${filter}"` : ""}. See eval/README.md.`);
    process.exit(2);
  }

  const model = env.extractionModel;
  console.log(`Model: ${model}  Fixtures: ${fixtures.length}\n`);

  const scores: MeetingScore[] = [];
  const runLog: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let errors = 0;

  for (const { name, fixture } of fixtures) {
    const report: PostProcessReport = { droppedItems: [], droppedCloses: [] };
    let score: MeetingScore;
    let usageLine = "";
    try {
      const old = saved?.get(name);
      if (saved && !old) throw new Error("not in the saved run");
      if (old) Object.assign(report, old.report);
      const result = old
        ? old.result
        : await extractMeeting(
            { transcript: fixture.transcript, user: fixture.user, meeting: fixture.meeting, openItems: fixture.openItems },
            { model, report },
          );
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      usageLine = `tokens ${result.usage.inputTokens} in / ${result.usage.outputTokens} out, ${inr(costInr(model, result.usage))}`;
      score = scoreMeeting(fixture.expected, result);
      runLog.push({ name, result, report });
    } catch (err) {
      errors++;
      console.log(`✗ ${name}: ERROR ${(err as Error).message}`);
      score = scoreMeeting(fixture.expected, { newItems: [], closes: [] });
    }
    scores.push(score);

    console.log(
      `${name}  (${fixture.meeting.title})\n` +
        `  correct ${score.correct.length}  missed ${score.missed.length}  wrong ${score.wrong.length}  ` +
        `closes ok ${score.correctCloses.length}  wrong closes ${score.wrongCloses.length}  missed closes ${score.missedCloses.length}` +
        (usageLine ? `\n  ${usageLine}` : ""),
    );
    for (const m of score.missed) console.log(`  - missed  [${m.kind}] ${m.text}${m.person ? ` (${m.person})` : ""}`);
    for (const w of score.wrong) console.log(`  - wrong   [${w.kind}] ${w.text}${w.person ? ` (${w.person})` : ""}  "${w.quote}"`);
    for (const id of score.wrongCloses) console.log(`  - wrong close   ${id}`);
    for (const id of score.missedCloses) console.log(`  - missed close  ${id}`);
    if (verbose) {
      for (const c of score.correct) console.log(`  + ok      [${c.actual.kind}] ${c.actual.text}  ~ ${c.expected.text}`);
      for (const c of score.optional) console.log(`  ~ optional [${c.actual.kind}] ${c.actual.text}  ~ ${c.expected.text}`);
      for (const id of score.optionalCloses) console.log(`  ~ optional close ${id}`);
      for (const d of report.droppedItems) console.log(`  · dropped item (${d.reason}): ${d.item.text}  "${d.item.quote}"`);
      for (const d of report.droppedCloses) console.log(`  · dropped close (${d.reason}): ${d.close.itemId}  "${d.close.quote}"`);
    }
    console.log("");
  }

  const t = totals(scores);
  const totalCost = costInr(model, { inputTokens, outputTokens });
  console.log("TOTAL");
  console.log(
    `  correct ${t.correct}  missed ${t.missed}  wrong ${t.wrong}  ` +
      `closes ok ${t.correctCloses}  wrong closes ${t.wrongCloses}  missed closes ${t.missedCloses}`,
  );
  console.log(`  precision ${pct(t.precision)}  recall ${pct(t.recall)}  (threshold ${pct(THRESHOLD.precision)} / ${pct(THRESHOLD.recall)})`);
  console.log(`  items:  precision ${pct(t.itemPrecision)}  recall ${pct(t.itemRecall)}`);
  console.log(`  closes: precision ${pct(t.closePrecision)}  recall ${pct(t.closeRecall)}`);
  console.log(`  tokens ${inputTokens} in / ${outputTokens} out, ${inr(totalCost)} (${inr(totalCost / fixtures.length)} per meeting)`);
  if (errors) console.log(`  ${errors} fixture(s) errored`);

  // Full model output of the last run, for reading misses. It holds transcript quotes, so it lives in
  // eval/fixtures/ (gitignored) and nowhere else.
  if (!saved) writeFileSync(path.join(FIXTURES, LAST_RUN), JSON.stringify(runLog, null, 2));

  const ok = passes(t) && errors === 0;
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
