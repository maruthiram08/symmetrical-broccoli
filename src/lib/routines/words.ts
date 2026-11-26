// Routines in plain words: "Every Friday", "Weekdays at 10:00", "Monthly on the 1st".
import type { Cadence } from "./types";

export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 1st, 2nd, 3rd, 4th, 11th, 21st, 31st */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "A, B and C" */
function list(xs: string[]): string {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Monday first, as people say them. */
const weekOrder = (d: number) => (d + 6) % 7;

/** The cadence alone: "Every day", "Weekdays", "Every Monday and Thursday", "Monthly on the 1st", "Every 3 days". */
export function cadenceWords(c: Cadence): string {
  switch (c.kind) {
    case "daily": return "Every day";
    case "weekdays": return "Weekdays";
    case "weekly": {
      const days = [...new Set(c.days)].sort((a, b) => weekOrder(a) - weekOrder(b));
      if (days.length === 7) return "Every day";
      if (days.length === 5 && days.every((d) => d >= 1 && d <= 5)) return "Weekdays";
      if (days.length === 2 && days.includes(0) && days.includes(6)) return "Weekends";
      return `Every ${list(days.map((d) => (days.length > 2 ? SHORT[d] : DAY_NAMES[d])))}`;
    }
    case "monthly": return `Monthly on the ${ordinal(c.day)}`;
    case "every": return c.n === 1 ? "Every day" : c.n === 2 ? "Every other day" : `Every ${c.n} days`;
  }
}

/** With the time: "Weekdays at 10:00". */
export function cadenceLabel(c: Cadence, time: string | null): string {
  return time ? `${cadenceWords(c)} at ${time}` : cadenceWords(c);
}

/** "20 Nov" for a local date. */
export function shortDay(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "Fri 27 Nov" for a local date. */
export function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${SHORT[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** "Today", "Tomorrow", else "Fri 27 Nov". */
export function relativeDay(date: string, today: string, tomorrow: string): string {
  return date === today ? "Today" : date === tomorrow ? "Tomorrow" : dayLabel(date);
}
