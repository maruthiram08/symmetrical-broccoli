// A thread found across meetings, in the detail pane: where it stands, how the decision moved, what's
// still open, and who and what tie it together. A suggestion: nothing here is filed until Keep.
import Link from "next/link";
import { itemLine } from "@/lib/reading/library";
import type { Ctx } from "@/lib/reading/model";
import { dayName, shortDay } from "@/lib/reading/model";
import { decisionTrail, standsTemplate, statusText, type FoundThread } from "@/lib/reading/threads";
import { localDate } from "@/lib/brief/time";
import type { Item } from "@/lib/types";
import type { Stands } from "@/server/local/threads";
import { Detail, DetailBar, Head, IRows, Keys, MList, RailCard, Sec } from "./Frame";
import { CopyButton, StandsCard, ThreadButtons } from "./MetActions";

const STATE = { moving: "Moving", stalled: "Stalled", wrapped: "Wrapped up" } as const;

function when(date: string, today: string): string {
  const d = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 7 ? `${d} days ago` : `on ${dayName(date).split(" ").slice(1).join(" ")}`;
}

export function ThreadDetail({ t, ctx, changes, stands, href, pos }: {
  t: FoundThread; ctx: Ctx; changes: Array<{ newId: string; oldId: string; status?: string }>; stands: Stands | null;
  href: (itemId: string) => string; pos: { n: number; of: number };
}) {
  const tz = ctx.timeZone;
  const saidAt = (i: Item) => ctx.meetings.get(i.meetingId)?.startedAt ?? i.createdAt;
  const today = localDate(ctx.now, tz);
  const trail = decisionTrail(t.decisions, changes, saidAt);
  const nChanges = trail.filter((s) => s.tag.kind === "changes").length;
  const first = t.meetings[0];
  const recent = [...t.meetings].reverse();
  const ai = stands?.text ?? null;
  const text = ai ?? standsTemplate(t, saidAt);
  const maxItems = Math.max(1, ...t.people.map((p) => p.items));
  const crumbHref = "/projects";
  return (
    <Detail
      bar={<DetailBar crumb={[{ label: "Projects", href: crumbHref }, { label: "Found in your meetings" }, { label: t.name }]} listHref={crumbHref} acts={<span className="rp-pos">{pos.n} of {pos.of}</span>} />}
      rail={<>
        <Sec title="Most involved">
          {t.people.slice(0, 6).map((p) => (
            <div key={p.name} className="rp-pbar">
              <span>{p.name}</span>
              <span className="rp-meter" aria-hidden="true">
                <span className="rp-meter__k" style={{ flex: (p.items - p.open) / maxItems }} />
                <span className="rp-meter__o" style={{ flex: p.open / maxItems }} />
                <span style={{ flex: 1 - p.items / maxItems }} />
              </span>
              <span>{p.items}</span>
            </div>
          ))}
          <p className="rp-quiet">Items each person is on. Lime = still open.</p>
        </Sec>
        <Sec title="Recent meetings">
          <MList rows={[
            ...recent.slice(0, 4).map((m) => ({ key: m.id, label: m.title || "Meeting", right: shortDay(m.startedAt, tz), href: `/meeting/${encodeURIComponent(m.id)}` })),
            ...(recent.length > 4 ? [{ key: "all", label: `All ${recent.length}`, right: "", href: "#rp-sources" }] : []),
          ]} />
        </Sec>
        <RailCard title="Why this is one thread">
          The same words ({t.phrases.slice(0, 3).join(", ")}), the same people ({t.people.slice(0, 3).map((p) => p.name).join(", ")})
          {t.closures.length ? `, and ${t.closures.length} ${t.closures.length === 1 ? "item" : "items"} a later meeting closed` : ""}. It&apos;s only a suggestion: nothing is filed until you keep it.
        </RailCard>
        <Keys rows={[["Copy status", "S"], ["Next / previous", "J K"]]} />
      </>}
    >
      <Head
        kind={<>Thread · Found in {t.meetings.length} meetings</>} mark="ring"
        st={[{ text: STATE[t.state], late: t.state === "stalled" }]}
        title={t.name} big
        lede={`Started ${shortDay(first.startedAt, tz)} with ${first.title || "a meeting"}. ${t.people.length} people, ${t.meetings.length} meetings, last touched ${when(t.lastItem, today)}.`}
        cta={<>
          <CopyButton text={statusText(t, text, saidAt, tz)} label="Copy status for PBR" k="s" pri />
          <ThreadButtons id={t.id} name={t.name} />
        </>}
      />
      <Sec title="Where it stands">
        <StandsCard id={t.id} text={text} ai={!!ai} stale={!!stands && stands.sig !== t.signature} meetings={t.meetings.length} sources="#rp-sources" />
      </Sec>
      {trail.length ? (
        <Sec title="How the decision moved" right={nChanges ? `${nChanges} ${nChanges === 1 ? "change" : "changes"}` : `${trail.length} ${trail.length === 1 ? "decision" : "decisions"}`}>
          <div className="rp-trail">
            {trail.slice(-8).map((s) => {
              const m = ctx.meetings.get(s.item.meetingId);
              const rel = s.tag.kind === "first" ? <span className="rp-rel">First call</span>
                : s.tag.kind === "now" ? <span className="rp-rel rp-rel--now">Stands now</span>
                  : s.tag.kind === "changes" ? <span className="rp-rel rp-rel--ch">Changes {shortDay(s.tag.of, tz)}</span>
                    : <span className="rp-rel">Adds to it</span>;
              return (
                <Link key={s.item.id} className={`rp-step${s.old ? " rp-step--old" : ""}`} href={href(s.item.id)} scroll={false}>
                  <span className="rp-step__d">{shortDay(saidAt(s.item), tz)}</span>
                  <span className="rp-m rp-m--decision" aria-hidden="true" />
                  <span className="rp-step__t"><span>{s.item.text}</span><small>{m?.title || "Meeting"}</small></span>
                  {rel}
                </Link>
              );
            })}
          </div>
        </Sec>
      ) : null}
      <Sec title={`Still open · ${t.open.length}`}>
        <IRows rows={t.open.map((i) => itemLine(i, ctx, href(i.id)))} empty="Nothing open. Every promise in this thread is kept." />
      </Sec>
      <section className="rp-sec" id="rp-sources">
        <h2>Meetings · {t.meetings.length}</h2>
        <div className="rp-mrows">
          {recent.map((m) => {
            const n = t.items.filter((i) => i.meetingId === m.id).length;
            return <Link key={m.id} className="rp-mrow" href={`/meeting/${encodeURIComponent(m.id)}`}><span>{dayName(localDate(new Date(m.startedAt), tz))}</span><span>{m.title || "Meeting"}</span><span>{n} {n === 1 ? "item" : "items"}</span></Link>;
          })}
        </div>
      </section>
    </Detail>
  );
}
