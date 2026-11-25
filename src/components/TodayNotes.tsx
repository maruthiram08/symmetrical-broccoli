import type { User } from "@/lib/types";
import { waitingOnYou, waitingPhrase } from "@/lib/wow/person-card";
import { quietStreak, streakNote } from "@/lib/wow/timeline";
import { loadAll } from "@/app/_lib/lines";
import { PersonPeek } from "./PersonPeek";

/** Two quiet lines on Today: who's waiting on you the most, and a streak of days with nothing overdue. */
export async function TodayNotes({ user, now }: { user: User; now: Date }) {
  const { items, meetings } = await loadAll(user);
  const people = waitingOnYou({ items, meetings, now, self: [user.name, ...user.aliases] });
  const streak = streakNote(quietStreak(items, meetings, now, user.timeZone));
  if (!people.length && !streak) return null;
  return (
    <div className="w3-notes">
      {people.length ? (
        <p className="w3-waiting">
          {people.map((p, k) => {
            const phrase = waitingPhrase(p);
            const rest = phrase.slice(p.name.length);
            return (
              <span key={p.slug} className="w3-waiting__one">
                <PersonPeek slug={p.slug}><b>{p.name}</b></PersonPeek>
                {rest}
                {k < people.length - 1 ? <span className="w3-waiting__sep" aria-hidden="true">·</span> : null}
              </span>
            );
          })}
        </p>
      ) : null}
      {streak ? <p className="w3-streak">{streak}</p> : null}
    </div>
  );
}
