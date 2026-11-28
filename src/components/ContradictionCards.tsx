// "This may change the decision from 24 Nov": a new decision that seems to change an earlier one.
import { resolveContradictionAction } from "@/app/ai-actions";
import type { User } from "@/lib/types";
import { openContradictions } from "@/server/ai";
import { Mark } from "./Mark";

const day = (iso: string, tz: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: tz });

export async function ContradictionCards({ user }: { user: User }) {
  const flags = await openContradictions(user);
  if (!flags.length) return null;
  return (
    <section className="db-contra" aria-label="Decisions that may have changed">
      {flags.map((f) => (
        <div key={f.id} className="db-contra__card" role="status">
          <p className="db-contra__head">
            <Mark kind="decision" />
            <span>
              <b>{f.newItem.text}</b>
              {f.newMeeting ? <span className="db-contra__src"> · {f.newMeeting.title}, {day(f.newMeeting.startedAt, user.timeZone)}</span> : null}
            </span>
          </p>
          <p className="db-contra__body">
            This may change the decision from {f.oldMeeting ? day(f.oldMeeting.startedAt, user.timeZone) : "earlier"}: &ldquo;{f.oldItem.text}&rdquo;
            {f.note ? <span className="db-contra__note"> ({f.note})</span> : null}
          </p>
          <p className="db-contra__quotes">
            <span>Then: &ldquo;{f.oldItem.quote}&rdquo;</span>
            <span>Now: &ldquo;{f.newItem.quote}&rdquo;</span>
          </p>
          <div className="db-contra__acts">
            <form action={resolveContradictionAction}>
              <input type="hidden" name="id" value={f.id} />
              <input type="hidden" name="how" value="replace" />
              <button className="db-act db-act--strong" type="submit">Mark old as replaced</button>
            </form>
            <form action={resolveContradictionAction}>
              <input type="hidden" name="id" value={f.id} />
              <input type="hidden" name="how" value="keep" />
              <button className="db-act" type="submit">Keep both</button>
            </form>
          </div>
        </div>
      ))}
    </section>
  );
}
