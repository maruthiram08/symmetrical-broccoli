import type { BriefLine } from "@/lib/types";
import type { Priority } from "@/lib/priority";

/** "Top 3 today": the three most pressing things you owe, by the local priority score. */
export function TopThree({ lines }: { lines: Array<BriefLine & { priority: Priority }> }) {
  if (!lines.length) return null;
  return (
    <p className="pr-top" aria-label={`Top ${lines.length} today`}>
      <span className="pr-top__label">Top {lines.length} today</span>
      {lines.map((l, k) => (
        <a key={l.itemId} className="pr-top__item" href={`/item/${encodeURIComponent(l.itemId)}`} title={l.priority.reasons.join(" · ")}>
          <span className="pr-top__n">{k + 1}</span>
          <span className="pr-top__text">{l.text}</span>
          {l.lateLabel ? <span className="pr-top__late">{l.lateLabel}</span> : l.dueLabel ? <span className="pr-top__due">{l.dueLabel}</span> : null}
        </a>
      ))}
    </p>
  );
}
