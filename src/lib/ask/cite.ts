// Citation parsing for Ask answers. Pure, used on the page as the answer streams in.

/** Splits an answer into text and citation runs: "a [1][3] b" -> text, cite 1, cite 3, text. */
export type AnswerPart = { type: "text"; text: string } | { type: "cite"; n: number };
export function parseCitations(answer: string, max: number): AnswerPart[] {
  const out: AnswerPart[] = [];
  const re = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;
  let last = 0;
  for (let m = re.exec(answer); m; m = re.exec(answer)) {
    const ns = m[1].split(",").map((x) => Number(x.trim()));
    if (!ns.every((n) => n >= 1 && n <= max)) continue; // not ours: leave as text
    if (m.index > last) out.push({ type: "text", text: answer.slice(last, m.index) });
    for (const n of ns) out.push({ type: "cite", n });
    last = m.index + m[0].length;
  }
  if (last < answer.length) out.push({ type: "text", text: answer.slice(last) });
  return out;
}

/** Source numbers cited in the answer, in first-cited order. */
export function citedNumbers(answer: string, max: number): number[] {
  const seen: number[] = [];
  for (const p of parseCitations(answer, max)) if (p.type === "cite" && !seen.includes(p.n)) seen.push(p.n);
  return seen;
}
