// npm run eval [-- <name filter>[,<filter>...]] [--verbose] [--rescore[=<file>]] [--repeat N]
//               [--only decisions|owe|waiting|items|closes] [--prompt baseline]
// Runs extractMeeting on every eval/fixtures/*.json with the real API and scores it. See eval/README.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { extractMeeting, type PostProcessReport } from "../src/lib/extract/extract";
import { costInr, costInrWithCache } from "../src/lib/extract/cost";
import { env } from "../src/lib/env";
import type { ExtractionResult } from "../src/lib/types";
import {
  attributionScore,
  attributionTotals,
  ONLY_VALUES,
  overlap,
  overlapTotals,
  passes,
  restrict,
  scoreMeeting,
  THRESHOLD,
  totals,
  type AttributionMatch,
  type MeetingScore,
  type Only,
  type Overlap,
} from "./score";
import { BASELINE_SYSTEM_PROMPT } from "./baseline-prompt";

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
  const parts = (filter ?? "").split(",").filter(Boolean);
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".out.json"))
    .filter((f) => parts.length === 0 || parts.some((p) => f.includes(p)))
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
export interface SavedRun {
  name: string;
  /** Which read of the meeting this is (0 for the first); missing in runs saved before --repeat. */
  repeat?: number;
  /** "baseline" when run with --prompt baseline. */
  prompt?: string;
  result: ExtractionResult;
  report: PostProcessReport;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const inr = (n: number) => `₹${n.toFixed(2)}`;

/** "--name value" or "--name=value". */
function option(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("-") ? args[i + 1] : undefined;
}

/** Open items of a fixture: decisions in openItems go to the model as earlier decisions, the rest as open items. */
function inputOf(fixture: Fixture) {
  return {
    transcript: fixture.transcript,
    user: fixture.user,
    meeting: fixture.meeting,
    openItems: fixture.openItems.filter((i) => i.kind !== "decision"),
    openDecisions: fixture.openItems.filter((i) => i.kind === "decision").map((i) => ({ text: i.text })),
  };
}

function describeMiss(m: AttributionMatch): string {
  const e = m.expected;
  const a = m.actual;
  const want = `${e.kind} ${Array.isArray(e.person) ? e.person.join("/") : (e.person ?? "nobody")}`;
  const got = `${a.kind} ${a.person ?? "nobody"}${a.attribution ? `, ${a.attribution}` : ""}`;
  return `  - misattributed  ${e.text}  (expected ${want}; got ${got})  "${a.quote}"`;
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose") || args.includes("-v");
  const valueOpts = new Set(["repeat", "only", "prompt"]);
  const filter = args.find((a, i) => !a.startsWith("-") && !(i > 0 && valueOpts.has(args[i - 1].replace(/^--/, ""))));
  const repeatArg = option(args, "repeat");
  const repeat = repeatArg ? Number(repeatArg) : 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5) {
    console.error("--repeat takes a whole number from 1 to 5.");
    process.exit(2);
  }
  const onlyArg = option(args, "only");
  if (onlyArg && !ONLY_VALUES.includes(onlyArg as Only)) {
    console.error(`--only takes one of: ${ONLY_VALUES.join(", ")}.`);
    process.exit(2);
  }
  const only = (onlyArg as Only | undefined) ?? null;
  const promptArg = option(args, "prompt");
  if (promptArg && promptArg !== "baseline" && promptArg !== "current") {
    console.error("--prompt takes baseline or current.");
    process.exit(2);
  }
  const baseline = promptArg === "baseline";

  // --rescore: score a saved run (default: the last one) against the current fixtures, with no API calls.
  const rescoreArg = args.find((a) => a === "--rescore" || a.startsWith("--rescore="));
  const savedRuns = rescoreArg
    ? (JSON.parse(readFileSync(path.join(FIXTURES, rescoreArg.split("=")[1] ?? LAST_RUN), "utf8")) as SavedRun[])
    : null;
  const saved = savedRuns ? new Map(savedRuns.map((r) => [`${r.name}#${r.repeat ?? 0}`, r])) : null;
  if (savedRuns && repeatArg) console.log("(--repeat is ignored with --rescore: the saved reads are scored)\n");
  const fixtures = loadFixtures(filter);
  if (fixtures.length === 0) {
    console.error(`No fixtures in ${FIXTURES}${filter ? ` matching "${filter}"` : ""}. See eval/README.md.`);
    process.exit(2);
  }

  const model = env.extractionModel;
  console.log(
    `Model: ${model}  Fixtures: ${fixtures.length}  Prompt: ${savedRuns ? `saved run (${savedRuns[0]?.prompt ?? "current"} prompt)` : baseline ? "baseline" : "current"}` +
      `${!savedRuns && repeat > 1 ? `  Reads per meeting: ${repeat}` : ""}${only ? `  Only: ${only}` : ""}\n`,
  );

  // Scores of each read: byRead[r][f]. The headline numbers use the first read, so they compare with single runs.
  const byRead: MeetingScore[][] = [];
  const attrByRead: AttributionMatch[][] = [];
  const decisionOverlaps: Overlap[] = [];
  const promiseOverlaps: Overlap[] = [];
  const runLog: SavedRun[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let errors = 0;
  let calls = 0;

  for (const { name, fixture } of fixtures) {
    const reads = savedRuns ? Math.max(0, ...savedRuns.filter((r) => r.name === name).map((r) => (r.repeat ?? 0) + 1)) || 1 : repeat;
    const results: Array<ExtractionResult | null> = [];
    for (let r = 0; r < reads; r++) {
      const report: PostProcessReport = { droppedItems: [], droppedCloses: [] };
      let score: MeetingScore;
      let usageLine = "";
      let result: ExtractionResult | null = null;
      try {
        const old = saved?.get(`${name}#${r}`);
        if (saved && !old) throw new Error("not in the saved run");
        if (old) Object.assign(report, old.report);
        result = old
          ? old.result
          : await extractMeeting(inputOf(fixture), {
              model,
              report,
              ...(baseline ? { system: BASELINE_SYSTEM_PROMPT } : {}),
              // Reads after the first reuse the cached request (5-minute cache), at a tenth of the input price.
              ...(repeat > 1 ? { cacheRequest: true } : {}),
            });
        calls++;
        const c = report.cache ? costInrWithCache(model, result.usage, report.cache) : costInr(model, result.usage);
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
        cost += c;
        const cached = report.cache?.readTokens ? `, ${report.cache.readTokens} cached` : "";
        usageLine = `tokens ${result.usage.inputTokens} in${cached} / ${result.usage.outputTokens} out, ${inr(c)}`;
        const scoped = restrict(only, fixture.expected, result);
        score = scoreMeeting(scoped.expected, scoped.actual);
        runLog.push({ name, ...(reads > 1 || r > 0 ? { repeat: r } : {}), ...(baseline ? { prompt: "baseline" } : {}), result, report });
      } catch (err) {
        errors++;
        console.log(`✗ ${name}${reads > 1 ? ` read ${r + 1}` : ""}: ERROR ${(err as Error).message}`);
        const scoped = restrict(only, fixture.expected, { newItems: [], closes: [] });
        score = scoreMeeting(scoped.expected, scoped.actual);
      }
      results.push(result);
      (byRead[r] ??= []).push(score);
      const attr = attributionScore(fixture.expected, result ?? { newItems: [] });
      (attrByRead[r] ??= []).push(...attr);

      const misattributed = attr.filter((m) => !m.correct);
      console.log(
        `${name}  (${fixture.meeting.title})${reads > 1 ? `  read ${r + 1}/${reads}` : ""}\n` +
          `  correct ${score.correct.length}  missed ${score.missed.length}  wrong ${score.wrong.length}  ` +
          `closes ok ${score.correctCloses.length}  wrong closes ${score.wrongCloses.length}  missed closes ${score.missedCloses.length}  ` +
          `attribution ${attr.length - misattributed.length}/${attr.length}` +
          (usageLine ? `\n  ${usageLine}` : ""),
      );
      for (const m of score.missed) console.log(`  - missed  [${m.kind}] ${m.text}${m.person ? ` (${m.person})` : ""}`);
      for (const w of score.wrong) console.log(`  - wrong   [${w.kind}] ${w.text}${w.person ? ` (${w.person})` : ""}  "${w.quote}"`);
      for (const id of score.wrongCloses) console.log(`  - wrong close   ${id}`);
      for (const id of score.missedCloses) console.log(`  - missed close  ${id}`);
      for (const m of misattributed) console.log(describeMiss(m));
      if (verbose) {
        for (const c of score.correct) console.log(`  + ok      [${c.actual.kind}] ${c.actual.text}  ~ ${c.expected.text}`);
        for (const c of score.optional) console.log(`  ~ optional [${c.actual.kind}] ${c.actual.text}  ~ ${c.expected.text}`);
        for (const id of score.optionalCloses) console.log(`  ~ optional close ${id}`);
        for (const d of report.droppedItems) console.log(`  · dropped item (${d.reason}): ${d.item.text}  "${d.item.quote}"`);
        for (const d of report.droppedCloses) console.log(`  · dropped close (${d.reason}): ${d.close.itemId}  "${d.close.quote}"`);
      }
      console.log("");
    }

    // Stability: every pair of reads of this meeting.
    if (reads > 1) {
      const lines: string[] = [];
      for (let i = 0; i < results.length; i++)
        for (let j = i + 1; j < results.length; j++) {
          const a = results[i];
          const b = results[j];
          if (!a || !b) continue;
          const d = overlap(a.newItems, b.newItems, ["decision"]);
          const p = overlap(a.newItems, b.newItems, ["owe", "waiting"]);
          decisionOverlaps.push(d);
          promiseOverlaps.push(p);
          lines.push(
            `  reads ${i + 1}~${j + 1}: decisions ${d.matched}/${d.union} same (${d.a} vs ${d.b})  owe+waiting ${p.matched}/${p.union} same`,
          );
          for (const x of d.onlyA) console.log(`  · decision only in read ${i + 1}: ${x.text}`);
          for (const x of d.onlyB) console.log(`  · decision only in read ${j + 1}: ${x.text}`);
          if (verbose) {
            for (const x of p.onlyA) console.log(`  · ${x.kind} only in read ${i + 1}: ${x.text}`);
            for (const x of p.onlyB) console.log(`  · ${x.kind} only in read ${j + 1}: ${x.text}`);
          }
        }
      console.log(`${name}  stability\n${lines.join("\n")}\n`);
    }
  }

  const printTotals = (label: string, scores: MeetingScore[], attr: AttributionMatch[]) => {
    const t = totals(scores);
    const a = attributionTotals(attr);
    console.log(label);
    console.log(
      `  correct ${t.correct}  missed ${t.missed}  wrong ${t.wrong}  ` +
        `closes ok ${t.correctCloses}  wrong closes ${t.wrongCloses}  missed closes ${t.missedCloses}`,
    );
    console.log(`  precision ${pct(t.precision)}  recall ${pct(t.recall)}  (threshold ${pct(THRESHOLD.precision)} / ${pct(THRESHOLD.recall)})`);
    console.log(`  items:  precision ${pct(t.itemPrecision)}  recall ${pct(t.itemRecall)}`);
    console.log(`  closes: precision ${pct(t.closePrecision)}  recall ${pct(t.closeRecall)}`);
    const src = (["label", "content", "none"] as const)
      .filter((k) => a.bySource[k].matched)
      .map((k) => `${k} ${a.bySource[k].correct}/${a.bySource[k].matched}`)
      .join(", ");
    console.log(`  attribution: ${a.correct}/${a.matched} right (${pct(a.accuracy)})${src ? `  [${src}]` : ""}`);
    return t;
  };

  // The first read is the headline (comparable with earlier single runs); the pass/fail uses it.
  const t = printTotals(byRead.length > 1 ? "TOTAL (read 1)" : "TOTAL", byRead[0], attrByRead[0]);
  for (let r = 1; r < byRead.length; r++) {
    console.log("");
    printTotals(`TOTAL (read ${r + 1})`, byRead[r], attrByRead[r]);
  }
  if (decisionOverlaps.length) {
    const d = overlapTotals(decisionOverlaps);
    const p = overlapTotals(promiseOverlaps);
    console.log("\nSTABILITY (items found in both reads / items in either, pooled over meetings)");
    console.log(`  decisions:   ${d.matched}/${d.union} (${pct(d.ratio)})`);
    console.log(`  owe+waiting: ${p.matched}/${p.union} (${pct(p.ratio)})`);
  }
  console.log("");
  console.log(
    `  tokens ${inputTokens} in / ${outputTokens} out, ${inr(cost)} (${inr(cost / Math.max(1, calls))} per read)` +
      (savedRuns ? " (saved run, nothing spent now)" : ""),
  );
  if (errors) console.log(`  ${errors} read(s) errored`);

  // Full model output of the last run, for reading misses. It holds transcript quotes, so it lives in
  // eval/fixtures/ (gitignored) and nowhere else.
  if (!savedRuns) writeFileSync(path.join(FIXTURES, LAST_RUN), JSON.stringify(runLog, null, 2));

  const ok = passes(t) && errors === 0;
  console.log(ok ? "\nPASS" : "\nFAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
