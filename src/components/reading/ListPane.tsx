// The list pane's frame: the 60px header (title, count, view options, add), an undo banner after
// Done or Not a promise, the app's alerts, then the groups.
import type { ReactNode } from "react";
import { setStatus } from "@/app/actions";
import type { Group } from "@/lib/reading/model";
import { PaneAlerts } from "../Shell";
import { AddButton, ListGroups, Popover } from "./Pane";

const FILTER = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4" /></svg>;

export function ListHeader({ title, count, options, add, tabs }: { title: string; count?: string; options?: ReactNode; add?: string | false; tabs?: ReactNode }) {
  return (
    <>
      <div className="rp-bar">
        <h1 className="rp-h1">{title}</h1>
        {count ? <span className="rp-n">{count}</span> : null}
        <span className="rp-sp" />
        {options ? <Popover label="View options" icon={FILTER} className="rp-pop--right">{options}</Popover> : null}
        {add === false ? null : <AddButton text={add} />}
      </div>
      {tabs}
    </>
  );
}

/** "Marked done. Undo" after an action, back on the page you were on. */
export function UndoBanner({ id, was, back }: { id?: string; was?: string; back: string }) {
  if (!id || (was !== "done" && was !== "wrong")) return null;
  return (
    <form action={setStatus} className="rp-undo" role="status">
      <span>{was === "wrong" ? "Marked not a promise." : "Marked done."}</span>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value="open" />
      <input type="hidden" name="back" value={back} />
      <button className="rp-undo__btn" type="submit">Undo</button>
    </form>
  );
}

export function ItemList({ title, count, options, add, groups, hrefBase, undo, top, tabs }: {
  title: string; count?: string; options?: ReactNode; add?: string | false; groups: Group[]; hrefBase: string;
  undo?: { id?: string; was?: string; back: string }; top?: ReactNode; tabs?: ReactNode;
}) {
  return (
    <>
      <ListHeader title={title} count={count} options={options} add={add} tabs={tabs} />
      <PaneAlerts />
      {undo ? <UndoBanner {...undo} /> : null}
      {top}
      <ListGroups groups={groups} hrefBase={hrefBase} />
    </>
  );
}

/** A link in a view-options menu. */
export function MenuLink({ href, on, children }: { href: string; on?: boolean; children: ReactNode }) {
  return <a role="menuitemradio" aria-checked={!!on} href={href}><span>{children}</span>{on ? <span>✓</span> : null}</a>;
}
