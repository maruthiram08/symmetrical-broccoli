import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Section } from "@/components/BriefList";
import { Shell } from "@/components/Shell";
import { fieldLabel, starterViews } from "@/lib/structure/views";
import { getStore, me } from "@/server/local/app";
import { newViewFormAction } from "../structure-actions";
import { openCountFor, pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Views" };

// Saved views over notes and items. Each one is also in the sidebar.
export default async function Views() {
  const user = await me();
  if (!user) redirect("/setup");
  const views = await getStore().listViews(user.id);
  const starters = starterViews().filter((s) => !views.some((v) => v.name === s.name));
  return (
    <Shell days={await pastDays(user.id, "")} current="views" openCount={await openCountFor(user.id)}>
      <h1 className="db-title">Views</h1>
      <p className="db-subtitle">Saved filters over your notes (by type, property or tag) and items (by status, kind, person, project or tag), as a table or a board. Kept with this workspace.</p>
      <form className="st-newview" action={newViewFormAction}>
        <input className="db-input" name="name" placeholder="New view name" aria-label="New view name" maxLength={60} autoComplete="off" />
        <select className="db-input" name="source" aria-label="Over">
          <option value="items">Items</option>
          <option value="notes">Notes</option>
        </select>
        <select className="db-input" name="layout" aria-label="Layout">
          <option value="table">Table</option>
          <option value="kanban">Kanban</option>
        </select>
        <button className="db-act db-act--primary" type="submit">New view</button>
      </form>
      <Section title="Your views" count={views.length ? String(views.length) : undefined} empty="No views yet. Make one above, or start from one below.">
        {views.length ? (
          <ul className="st-list">
            {views.map((v) => (
              <li key={v.id}>
                <Link className="st-list__row" href={`/views/${encodeURIComponent(v.id)}`}>
                  <span>{v.name}</span>
                  <span className="st-list__meta">
                    {v.source === "items" ? "Items" : "Notes"} · {v.layout === "kanban" ? "Kanban" : "Table"}
                    {v.group ? ` by ${fieldLabel(v.group).toLowerCase()}` : ""}
                    {v.filters.length ? ` · ${v.filters.length} filter${v.filters.length === 1 ? "" : "s"}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
      {starters.length ? (
        <Section title="Start from">
          <ul className="st-list">
            {starters.map((s) => (
              <li key={s.name}>
                <form action={newViewFormAction} className="st-list__row st-list__row--form">
                  <input type="hidden" name="name" value={s.name} />
                  <input type="hidden" name="source" value={s.source} />
                  <input type="hidden" name="layout" value={s.layout} />
                  <input type="hidden" name="starter" value={JSON.stringify({ filters: s.filters, sort: s.sort, group: s.group })} />
                  <span>{s.name}</span>
                  <span className="st-list__meta">{s.source === "items" ? "Items" : "Notes"} · {s.layout === "kanban" ? "Kanban" : "Table"}</span>
                  <button className="db-act" type="submit">Add</button>
                </form>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </Shell>
  );
}
