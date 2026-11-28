// The pieces every library page shares in the reading pane: a list of link rows in groups, and a
// detail with its 60px bar, a main column and the 264px rail. Selection is the page's own URL.
import Link from "next/link";
import type { ReactNode } from "react";

export interface LinkRow {
  key: string;
  href: string;
  title: ReactNode;
  sub?: ReactNode;
  /** A third, fainter line. */
  last?: ReactNode;
  badge?: ReactNode;
  late?: boolean;
  /** An rp-m mark: owe, waiting, late, done, decision, proj, ring, dot. */
  mark?: string;
  /** Initials in a circle, in place of the mark. */
  av?: string;
  /** A big number on the right, with a small word under it. */
  num?: { n: ReactNode; label?: string };
  bold?: boolean;
}
export interface LinkGroup { key: string; label: string; rows: LinkRow[]; empty?: string; late?: boolean }

const BACK = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>;

/** Initials for an avatar: "Shubham Beohar" → "SB". */
export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function LinkRowView({ r, sel }: { r: LinkRow; sel: boolean }) {
  return (
    <div className={`rp-lrow${sel ? " rp-row--sel" : ""}${r.num ? " rp-lrow--num" : ""}`} aria-current={sel ? "true" : undefined}>
      {r.av ? <span className="rp-av" aria-hidden="true">{r.av}</span> : <span className={`rp-m rp-m--${r.mark ?? "dot"}`} aria-hidden="true" />}
      <div className="rp-lrow__body">
        <Link className={`rp-lrow__t${r.bold ? " rp-lrow__t--b" : ""}`} href={r.href} scroll={false}>{r.title}</Link>
        {r.sub ? <div className="rp-lrow__s">{r.sub}</div> : null}
        {r.last ? <div className="rp-lrow__l">{r.last}</div> : null}
      </div>
      {r.num ? <div className="rp-prow__num">{r.num.n}{r.num.label ? <small>{r.num.label}</small> : null}</div>
        : r.badge !== undefined && r.badge !== null && r.badge !== "" ? <span className={`rp-badge${r.late ? " rp-badge--late" : ""}`}>{r.badge}</span> : <span />}
    </div>
  );
}

/** Groups of link rows: a sticky header each, six rows, then "Show N more". */
export function LinkGroups({ groups, sel, limit = 6, foot }: { groups: LinkGroup[]; sel?: string | null; limit?: number; foot?: ReactNode }) {
  return (
    <div className="rp-scroll">
      {groups.map((g) => {
        const shown = g.rows.slice(0, limit);
        const rest = g.rows.slice(limit);
        const open = rest.some((r) => r.key === sel);
        return (
          <section key={g.key} aria-label={g.label}>
            <h2 className={`rp-gh${g.late ? " rp-gh--late" : ""}`} id={`rp-g-${g.key}`}>{g.label}<span className="rp-gh__n">{g.rows.length}</span></h2>
            {g.rows.length ? null : <p className="rp-empty">{g.empty ?? "Nothing here."}</p>}
            {shown.map((r) => <LinkRowView key={r.key} r={r} sel={r.key === sel} />)}
            {rest.length ? (
              <details className="rp-lmore" open={open || undefined}>
                <summary className="rp-more">Show {rest.length} more</summary>
                {rest.map((r) => <LinkRowView key={r.key} r={r} sel={r.key === sel} />)}
              </details>
            ) : null}
          </section>
        );
      })}
      {foot ? <div className="rp-lfoot">{foot}</div> : null}
    </div>
  );
}

/** Jump chips under the list header. */
export function Chips({ chips }: { chips: Array<{ label: string; n?: ReactNode; href: string; on?: boolean }> }) {
  return (
    <nav className="rp-chips" aria-label="Jump to">
      {chips.map((c) => <Link key={c.label} className={`rp-chip${c.on ? " rp-chip--on" : ""}`} href={c.href} scroll={false}>{c.n !== undefined ? <b>{c.n}</b> : null}{c.label}</Link>)}
    </nav>
  );
}

/** The list pane's 60px bar. */
export function ListBar({ title, count, back, children }: { title: string; count?: ReactNode; back?: { href: string; label: string }; children?: ReactNode }) {
  return (
    <div className="rp-bar">
      {back ? <Link className="rp-back" href={back.href}>{BACK}{back.label}</Link> : null}
      <h1 className="rp-h1">{title}</h1>
      {count !== undefined && count !== null ? <span className="rp-n">{count}</span> : null}
      <span className="rp-sp" />
      {children}
    </div>
  );
}

export interface CrumbPart { label: string; href?: string }

/** The detail's 60px bar: a way back to the list on phones, the breadcrumb, and actions. */
export function DetailBar({ crumb, listHref, acts }: { crumb: CrumbPart[]; listHref?: string; acts?: ReactNode }) {
  const last = crumb[crumb.length - 1];
  return (
    <div className="rp-bar rp-bar--det">
      <div className="rp-crumb">
        {listHref ? <Link className="rp-back rp-back--list" href={listHref} scroll={false}>{BACK}Back</Link> : null}
        {crumb.slice(0, -1).map((c, i) => (
          <span key={i} className="rp-crumb__page">{c.href ? <Link href={c.href}>{c.label}</Link> : c.label}<span aria-hidden="true" className="rp-crumb__sep">›</span></span>
        ))}
        {last ? <b>{last.label}</b> : null}
      </div>
      {acts ? <div className="rp-acts">{acts}</div> : null}
    </div>
  );
}

/** Detail frame: bar, then the main column and (unless `full`) the rail. */
export function Detail({ bar, children, rail, full, wide }: { bar: ReactNode; children: ReactNode; rail?: ReactNode; full?: boolean; wide?: boolean }) {
  return (
    <div className="rp-wrap">
      {bar}
      <div className={`rp-dbody${rail && !full ? "" : " rp-dbody--one"}`}>
        <div className={`rp-main${wide || full ? " rp-main--wide" : ""}`}>{children}</div>
        {rail && !full ? <aside className="rp-rail" aria-label="About this">{rail}</aside> : null}
      </div>
    </div>
  );
}

/** Kind line, title, lede and the CTA row. */
export function Head({ kind, mark, st, title, lede, cta, big }: {
  kind: ReactNode; mark?: string; st?: Array<{ text: ReactNode; late?: boolean }>; title: ReactNode; lede?: ReactNode; cta?: ReactNode; big?: boolean;
}) {
  return (
    <div>
      <div className="rp-kind">{mark ? <span className={`rp-m rp-m--${mark}`} aria-hidden="true" /> : null}{kind}{st?.map((s, i) => <span key={i} className={`rp-st${s.late ? " rp-st--late" : ""}`}>{s.text}</span>)}</div>
      <h2 className={big ? "rp-title rp-title--big" : "rp-title"}>{title}</h2>
      {lede ? <p className="rp-lede">{lede}</p> : null}
      {cta ? <div className="rp-cta">{cta}</div> : null}
    </div>
  );
}

export interface IRow { key: string; href?: string; mark?: string; num?: ReactNode; title: ReactNode; small?: ReactNode; badge?: ReactNode; late?: boolean; done?: boolean }

function IRowView({ r }: { r: IRow }) {
  const inner = (
    <>
      {r.num !== undefined ? <span className="rp-irow__num">{r.num}</span> : <span className={`rp-m rp-m--${r.mark ?? "dot"}`} aria-hidden="true" />}
      <span className={`rp-irow__t${r.done ? " rp-sib__t--done" : ""}`}>{r.title}{r.small ? <small>{r.small}</small> : null}</span>
      <span className={`rp-sib__b${r.late ? " rp-late" : ""}`}>{r.badge}</span>
    </>
  );
  return r.href ? <Link className="rp-irow" href={r.href} scroll={false}>{inner}</Link> : <div className="rp-irow">{inner}</div>;
}

/** Item rows in a bordered box: mark, title with a small line, badge; six, then Show N more. */
export function IRows({ rows, limit = 6, empty }: { rows: IRow[]; limit?: number; empty?: string }) {
  if (!rows.length) return <div className="rp-irows"><div className="rp-irow rp-irow--none"><span /><span>{empty ?? "Nothing here."}</span><span /></div></div>;
  const rest = rows.slice(limit);
  return (
    <div className="rp-irows">
      {rows.slice(0, limit).map((r) => <IRowView key={r.key} r={r} />)}
      {rest.length ? (
        <details className="rp-imore">
          <summary>Show {rest.length} more</summary>
          {rest.map((r) => <IRowView key={r.key} r={r} />)}
        </details>
      ) : null}
    </div>
  );
}

export function Sec({ title, right, children }: { title: ReactNode; right?: ReactNode; children: ReactNode }) {
  return <section className="rp-sec"><h2>{title}{right ? <span className="rp-sec__r">{right}</span> : null}</h2>{children}</section>;
}

export function Stats({ items }: { items: Array<{ n: ReactNode; label: string; late?: boolean }> }) {
  return <div className="rp-stats">{items.map((s) => <div key={s.label} className={s.late ? "rp-stats--late" : undefined}><b>{s.n}</b><span>{s.label}</span></div>)}</div>;
}

export function Kv({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  return <dl className="rp-kv">{rows.filter((r): r is [string, ReactNode] => !!r).map(([k, v]) => <div key={k} className="rp-kv__r"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export function MList({ rows, empty }: { rows: Array<{ key: string; label: ReactNode; right?: ReactNode; href?: string }>; empty?: string }) {
  if (!rows.length) return <p className="rp-quiet">{empty ?? "None yet."}</p>;
  return (
    <div className="rp-mlist">
      {rows.map((r) => r.href
        ? <Link key={r.key} href={r.href}><span>{r.label}</span><span>{r.right}</span></Link>
        : <div key={r.key}><span>{r.label}</span><span>{r.right}</span></div>)}
    </div>
  );
}

export function Ppl({ names, empty, href }: { names: string[]; empty?: string; href?: (n: string) => string }) {
  if (!names.length) return <p className="rp-quiet">{empty ?? "No one yet."}</p>;
  return <div className="rp-ppl">{names.map((n) => (href ? <Link key={n} href={href(n)}>{n}</Link> : <span key={n}>{n}</span>))}</div>;
}

export function Keys({ rows }: { rows: Array<[string, string]> }) {
  return (
    <Sec title="Keys">
      <div className="rp-keys">{rows.map(([l, k]) => [<span key={`${l}l`}>{l}</span>, <span key={`${l}k`} className="rp-kbd">{k}</span>])}</div>
    </Sec>
  );
}

/** A note card in the rail. */
export function RailCard({ title, children, link }: { title: ReactNode; children?: ReactNode; link?: { href: string; label: string } }) {
  return (
    <div className="rp-rcard">
      <b>{title}</b>
      {children ? <span className="rp-note">{children}</span> : null}
      {link ? <Link className="rp-pcard__go" href={link.href}>{link.label}</Link> : null}
    </div>
  );
}

/** A segmented control of links. */
export function Seg({ items, label }: { items: Array<{ label: string; href: string; on?: boolean }>; label: string }) {
  return (
    <div className="rp-seg" role="group" aria-label={label}>
      {items.map((s) => <Link key={s.label} href={s.href} aria-current={s.on ? "true" : undefined} scroll={false}>{s.label}</Link>)}
    </div>
  );
}

/** The detail with nothing picked. */
export function NoneDetail({ crumb, text, listHref }: { crumb: CrumbPart[]; text: ReactNode; listHref?: string }) {
  return <div className="rp-wrap"><DetailBar crumb={crumb} listHref={listHref} /><p className="rp-quiet rp-quiet--pad">{text}</p></div>;
}
