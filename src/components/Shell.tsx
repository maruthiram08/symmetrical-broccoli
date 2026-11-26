import Link from "next/link";
import type { ReactNode } from "react";
import { SearchIcon } from "./SearchIcon";
import { Progress } from "./Progress";
import { SideNav } from "./SideNav";
import { HostedLinks } from "./HostedLinks";

/** Sidebar and reading column. `days` are past daily notes, newest first. */
export function Shell({ days, current, children, footer, openCount, query }: { days: Array<{ date: string; label: string }>; current: string; children: ReactNode; footer?: ReactNode; openCount?: number; query?: string }) {
  return (
    <div className="db-shell">
      <SideNav brand={<span><i aria-hidden="true" />Daily brief</span>}>
        <form className="db-search" action="/search" role="search">
          <SearchIcon />
          <input id="db-search" className="db-search__input" type="search" name="q" defaultValue={query} placeholder="Search" aria-label="Search everything" autoComplete="off" />
          <span className="db-kbd" aria-hidden="true">⌘K</span>
        </form>
        <Link className="db-nav" href="/" aria-current={current === "today" || current === "wrap" || current === "week" ? "page" : undefined}>Today</Link>
        <Link className="db-nav" href="/open" aria-current={current === "open" || current === "item" ? "page" : undefined}>
          All open{openCount ? <span className="db-nav__n">{openCount}</span> : null}
        </Link>
        <Link className="db-nav" href="/people" aria-current={current === "people" ? "page" : undefined}>People</Link>
        <Link className="db-nav" href="/series" aria-current={current === "series" ? "page" : undefined}>Recurring</Link>
        <Link className="db-nav" href="/ask" aria-current={current === "ask" ? "page" : undefined}>Ask</Link>
        {days.length ? <div className="db-side__group">Earlier</div> : null}
        {days.map((d) => (
          <Link key={d.date} className="db-nav" href={`/day/${d.date}`} aria-current={current === d.date ? "page" : undefined}>
            {d.label}
          </Link>
        ))}
        <div className="db-side__foot">
          <Link className="db-nav" href="/setup">Settings</Link>
          <HostedLinks />
          {footer}
        </div>
      </SideNav>
      <main className="db-main">
        <div className="db-main__col"><Progress />{children}</div>
      </main>
    </div>
  );
}
