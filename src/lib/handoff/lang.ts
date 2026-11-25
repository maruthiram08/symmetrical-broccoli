// A small Hinglish detector: enough to tell the drafter whether romanised Hindi is welcome.

const HINDI_WORDS = new Set([
  "haan", "nahi", "nahin", "hai", "hain", "hoon", "hu", "kar", "karo", "karna", "karta", "karti", "karenge", "kardo",
  "kar", "deta", "deti", "dunga", "dungi", "bhej", "bhejo", "bhejta", "bhejdo", "wala", "wali", "wale", "kya", "kyun",
  "acha", "accha", "achha", "theek", "thik", "toh", "bhi", "abhi", "kal", "aaj", "mein", "mujhe", "tum", "aap", "yaar",
  "matlab", "lekin", "aur", "ho", "jayega", "jaayega", "chalo", "dekh", "dekhte", "dekhta", "bata", "batao", "baat",
  "kaam", "sab", "kuch", "maine", "humne", "hum", "ek", "do", "bas", "na", "ji",
]);

/** True when the text is Devanagari or has at least two common romanised Hindi words. */
export function isHinglish(text: string): boolean {
  if (/[ऀ-ॿ]/.test(text)) return true;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  // "do", "na", "ho", "ek" are also English or too short to count alone.
  const weak = new Set(["do", "na", "ho", "ek", "hu", "ji", "bas", "sab", "aur", "kar"]);
  let strong = 0;
  let any = 0;
  for (const w of words) {
    if (!HINDI_WORDS.has(w)) continue;
    any++;
    if (!weak.has(w)) strong++;
  }
  return strong >= 1 && any >= 2;
}
