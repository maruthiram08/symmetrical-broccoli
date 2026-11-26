// Routines in the daily note and in the channel digest.
import { esc } from "@/lib/brief/markdown";
import type { RoutineLine } from "./types";

/** "## Routines due today" for the daily note, or nothing when none are due. */
export function renderRoutinesSection(lines: RoutineLine[] | undefined): string[] {
  if (!lines?.length) return [];
  const out = ["## Routines due today", ""];
  for (const l of lines) {
    const when = l.overdueLabel ? ` **(${l.overdueLabel})**` : l.time ? ` (${l.time})` : "";
    out.push(`- [ ] ${esc(l.title)}${when}`, `  ${esc(l.cadenceLabel)}${l.person ? ` · ${esc(l.person)}` : ""}`);
  }
  out.push("");
  return out;
}

/** "2 routines due", for one-line summaries. */
export function routinesCount(lines: RoutineLine[] | undefined): string | null {
  const n = lines?.length ?? 0;
  return n ? `${n} routine${n === 1 ? "" : "s"} due` : null;
}
