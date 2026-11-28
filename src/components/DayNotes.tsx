"use client";

// Your own notes on a day, saved into that day's .md (between markers) as you type.
import { saveDayNotesAction } from "@/app/capture-actions";
import { LazyEditor as MarkdownEditor } from "./editor/LazyEditor";

export interface DayNotesProps {
  date: string;
  initial: string;
  timeZone: string;
  today: string;
  assist: { enabled: boolean; reason?: string };
  notes?: Array<{ slug: string; title: string }>;
  title?: string;
  autoFocus?: boolean;
}

export function DayNotes({ date, initial, timeZone, today, assist, notes, title = "Your notes", autoFocus }: DayNotesProps) {
  return (
    <section className="db-section db-daynotes" aria-labelledby={`db-daynotes-title-${date}`}>
      <div className="db-section__head">
        <h2 className="db-section__title" id={`db-daynotes-title-${date}`}>{title}</h2>
      </div>
      <MarkdownEditor
        key={date}
        docKey={`day:${date}`}
        initial={initial}
        save={(md) => saveDayNotesAction(date, md)}
        timeZone={timeZone}
        today={today}
        assist={assist}
        notes={notes}
        label={`${title}, ${date}`}
        autoFocus={autoFocus}
        placeholder="What else happened, what to remember tomorrow… Type / for commands, [[ to link."
        idleText="Saved in the day's .md, kept when the brief is written again."
      />
    </section>
  );
}
