// Sound-alike keys for names as speech-to-text writes them, tuned for Indian names:
// "Mangku", "Mungu", "Manku" and "Munkku" share a key; so do "Nitin"/"Nithin" and "Jeetendar"/"Jitender".
// A small rule set in the spirit of Double Metaphone: fold aspirates (th→t, dh→d, bh→b, kh→k...),
// merge voiced and voiceless pairs (g/k, d/t, b/p), drop vowels after the first letter, and collapse
// doubled letters. Pure.

/** Lowercase ASCII letters only: "Zoë O'Neil" -> "zoeoneil". */
export function foldLetters(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]+/g, "");
}

const RULES: Array<[RegExp, string]> = [
  [/ph/g, "f"], [/gh/g, "g"], [/kh/g, "k"], [/bh/g, "b"], [/dh/g, "d"], [/th/g, "t"], [/jh/g, "j"],
  [/sh/g, "s"], [/ch/g, "c"], [/ck/g, "k"], [/q/g, "k"], [/x/g, "ks"], [/z/g, "j"], [/w/g, "v"],
  // voiced and voiceless stops sound alike in quick speech
  [/g/g, "k"], [/d/g, "t"], [/b/g, "p"],
];

/** The sound key of one word: "Jeetendar" -> "jtntr", "Anirudhan" -> "anrtn". */
export function soundKey(word: string): string {
  let s = foldLetters(word);
  if (!s) return "";
  for (const [re, to] of RULES) s = s.replace(re, to);
  // Collapse doubled letters before dropping vowels, so "Munkku" folds but "Nandani" keeps both n's.
  s = s.replace(/(.)\1+/g, "$1");
  const first = /[aeiouy]/.test(s[0]) ? "a" : s[0];
  return first + s.slice(1).replace(/[aeiouyh]/g, "");
}

/** Sound key of a whole name, word by word: "Nithin Kumar" -> "ntn kmr". */
export function nameKey(name: string): string {
  return name.split(/[\s.\-_']+/).map(soundKey).filter(Boolean).join(" ");
}

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** How alike two sound keys are, 0..1. Equal 1; one a prefix of the other ("anrt", "anrtn") .85. */
export function keySimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) return 0.85;
  return Math.max(0, 1 - (2 * editDistance(a, b)) / Math.max(a.length, b.length));
}

/** How alike two spellings are, 0..1, by edit distance on the letters. */
export function spellingSimilarity(a: string, b: string): number {
  const x = foldLetters(a), y = foldLetters(b);
  if (!x || !y) return 0;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}
