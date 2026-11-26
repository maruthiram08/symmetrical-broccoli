import Link from "next/link";
import { markOccurrenceAction, snoozeOccurrenceAction } from "@/app/routine-actions";
import { Section } from "@/components/BriefList";
import { ItemActs } from "@/components/ItemActs";
import { dayLabel } from "@/lib/routines/words";
import type { RoutineLine } from "@/lib/routines/types";
import { TitleWithPerson } from "./Who";

function Mark({ line, status, label, cls }: { line: RoutineLine; status: "done" | "skipped"; label: string; cls?: string }) {
  return (
    <form action={markOccurrenceAction} className={cls}>
      <input type="hidden" name="routine" value={line.routineId} />
      <input type="hidden" name="date" value={line.date} />
      <input type="hidden" name="status" value={status} />
      <button className="db-act" type="submit">{label}</button>
    </form>
  );
}

/**
 * Today's routines: the ones due today, then ones still open from the last few days. The tick marks
 * that one occurrence done; Skip lets it go; Tomorrow snoozes it. Red only when overdue.
 */
export function TodayRoutines({ lines, today }: { lines: RoutineLine[]; today: string }) {
  if (!lines.length) return null;
  return (
    <Section title="Routines" count={String(lines.length)}>
      {lines.map((l) => (
        <div key={l.routineId} className={`db-item rt-item${l.overdueLabel ? " rt-item--overdue" : ""}`}>
          <form action={markOccurrenceAction} className="db-item__icon">
            <input type="hidden" name="routine" value={l.routineId} />
            <input type="hidden" name="date" value={l.date} />
            <input type="hidden" name="status" value="done" />
            <button className="rt-tick" type="submit" aria-label={`Done: ${l.title}${l.date === today ? "" : `, ${dayLabel(l.date)}`}`} title="Done for this day" />
          </form>
          <span className="db-item__text"><TitleWithPerson title={l.title} person={l.person} /></span>
          <span className="db-item__side">
            {l.overdueLabel ? <span className="db-item__late">{l.overdueLabel}</span> : l.time ? <span className="db-item__time">{l.time}</span> : null}
          </span>
          <span className="db-item__meta">
            <Link className="db-item__src" href="/routines">{l.cadenceLabel}</Link>
            {l.date !== today ? <span className="db-item__src">· from {dayLabel(l.date)}</span> : null}
          </span>
          <ItemActs>
            <form action={snoozeOccurrenceAction}>
              <input type="hidden" name="routine" value={l.routineId} />
              <button className="db-act" type="submit">Tomorrow</button>
            </form>
            <Mark line={l} status="skipped" label="Skip" cls="db-act-keep" />
          </ItemActs>
        </div>
      ))}
    </Section>
  );
}
