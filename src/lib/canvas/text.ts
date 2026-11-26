// Small text helpers for the canvas builders: content words, and a node's height from its text, so
// columns stack without measuring in the browser. Node text is clamped to three lines in CSS.

const STOP = new Set(
  ("a an the and or but if of to in on at by for from with about as is are was were be been it its this that these those " +
    "i me my we us our you your he she they them their will would should can could may might must do does did done have has had " +
    "not no yes so than then just also into over out up down new next last more most some any all each per via vs " +
    // Words in nearly every meeting title, which say nothing about the topic.
    "meeting meetings sync call calls discussion discuss review reviews update updates plan planning implementation overview " +
    "progress standup daily weekly team check checkin catch catchup chat session notes follow followup details detail requirements " +
    "guidelines process introduction intro walkthrough demo kickoff ui ux issue issues feature features change changes work " +
    "ticket sprint build release pr qa standup status prioritization").split(" "),
);

/** Lowercase content words, plural s dropped ("actions" → "action"). */
export function words(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

/** Content-word pairs that sit next to each other in the text ("stock split"). */
export function pairs(s: string): string[] {
  const out: string[] = [];
  const ws = (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  for (let i = 0; i + 1 < ws.length; i++) {
    const a = ws[i], b = ws[i + 1];
    if (a.length > 2 && b.length > 2 && !STOP.has(a) && !STOP.has(b) && !/^\d+$/.test(a) && !/^\d+$/.test(b)) out.push(`${a} ${b}`);
  }
  return out;
}

/** True when the text has every word of the phrase. */
export function mentions(text: string, phrase: string): boolean {
  const have = new Set(words(text));
  const want = words(phrase);
  return want.length > 0 && want.every((w) => have.has(w));
}

/** "stock split" → "Stock split". */
export const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const lines = (s: string, w: number, px: number) => (s ? Math.min(3, Math.max(1, Math.ceil((s.length * px) / Math.max(60, w - 26)))) : 0);

/** A card's height in pixels for its text at width w (label, title, sub, quote, buttons). */
export function cardHeight(n: { w: number; title: string; sub?: string; quote?: string; label?: string; actions?: unknown[] }): number {
  return 22 + (n.label ? 18 : 0) + lines(n.title, n.w, 7.6) * 20 + (n.sub ? lines(n.sub, n.w, 6.6) * 17 + 3 : 0) + (n.quote ? lines(n.quote, n.w, 6.6) * 17 + 4 : 0) + (n.actions?.length ? 34 : 0);
}

/** Shorten to n characters on a word boundary. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n * 0.6)).trimEnd()}…`;
}
