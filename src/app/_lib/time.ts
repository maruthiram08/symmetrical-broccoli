/** "18:00" -> "6:00 PM". */
export function formatBriefTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Every 15 minutes of the day as "HH:MM". */
export const BRIEF_TIMES: string[] = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timeZones(): string[] {
  const list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return list.includes("Asia/Kolkata") ? list : ["Asia/Kolkata", ...list];
}

/** "today" if the brief time is still ahead in the user's zone, else "tomorrow". */
export function nextBriefDay(briefTime: string, timeZone: string, now: Date = new Date()): "today" | "tomorrow" {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return parts < briefTime ? "today" : "tomorrow";
}
