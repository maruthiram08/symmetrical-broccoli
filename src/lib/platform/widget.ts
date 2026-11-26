// The phone widget's numbers: "3 you owe today · 1 overdue". Built from the same brief as Today,
// so the widget, the tray count and the Today screen always agree.
import { buildBrief } from "@/lib/brief/build";
import type { User } from "@/lib/types";
import type { Store } from "@/server/store";

export interface WidgetSummary {
  /** One line for a widget or notification. */
  text: string;
  /** Things you owe on Today (overdue ones included). */
  owe: number;
  overdue: number;
  waiting: number;
  /** The first thing you owe, for a widget's second line. */
  next: string | null;
  date: string;
  updatedAt: string;
}

export function widgetText(owe: number, overdue: number): string {
  if (owe === 0) return "Nothing owed today";
  return overdue ? `${owe} you owe today · ${overdue} overdue` : `${owe} you owe today`;
}

export async function widgetSummary(store: Store, user: User, now: Date): Promise<WidgetSummary> {
  const b = await buildBrief(store, user, now);
  const owe = b.youOwe.length;
  const overdue = b.youOwe.filter((l) => l.lateMinutes !== null).length;
  return {
    text: widgetText(owe, overdue),
    owe,
    overdue,
    waiting: b.waitingOn.length,
    next: b.youOwe[0]?.text ?? null,
    date: b.date,
    updatedAt: now.toISOString(),
  };
}

/** The menu bar title on the Mac: the count, or nothing when you owe nothing. */
export function trayTitle(s: Pick<WidgetSummary, "owe">): string {
  return s.owe > 0 ? String(s.owe) : "";
}
