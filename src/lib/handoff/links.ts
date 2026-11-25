// Deep links for the hand-off targets. All of them only open a place; none of them send.

/** Opens the Slack app. We don't know channel ids, so the user pastes the copied draft. */
export const SLACK_URL = "slack://open";

/** Safe length for a mailto: link across Mail and browsers. */
export const MAILTO_MAX = 1800;
/** Keep claude.ai/new?q= well under common URL limits. */
export const CLAUDE_URL_MAX = 6000;

/** Largest prefix of `s` (by code point) whose encoded form fits in `max`, with a marker when cut. */
export function fitEncoded(s: string, max: number, marker = "\n\n[Cut short. The full version is on my clipboard.]"): string {
  if (encodeURIComponent(s).length <= max) return s;
  const cps = Array.from(s);
  const budget = max - encodeURIComponent(marker).length;
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encodeURIComponent(cps.slice(0, mid).join("")).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join("").replace(/\s+$/, "") + marker;
}

export function mailtoUrl(subject: string, body: string, to = ""): string {
  const s = encodeURIComponent(subject);
  const fixed = `mailto:${encodeURIComponent(to)}?subject=${s}&body=`.length;
  const b = fitEncoded(body, Math.max(200, MAILTO_MAX - fixed), "\n…");
  return `mailto:${encodeURIComponent(to)}?subject=${s}&body=${encodeURIComponent(b)}`;
}

export function claudeUrl(prompt: string): string {
  const base = "https://claude.ai/new?q=";
  return base + encodeURIComponent(fitEncoded(prompt, CLAUDE_URL_MAX - base.length));
}
