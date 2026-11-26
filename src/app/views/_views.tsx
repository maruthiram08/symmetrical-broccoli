// Views in the reading pane: your saved views and "Start from" templates in the list; the picked
// view, as a table or a board with its filters, in the detail.
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Detail, DetailBar, Head, LinkGroups, ListBar, Sec, type LinkGroup } from "@/components/reading/Frame";
import { ViewEditor } from "@/components/structure/ViewEditor";
import { propTypeFor, typeOf } from "@/lib/structure/note-types";
import { fieldLabel, starterViews } from "@/lib/structure/views";
import { getStore, me } from "@/server/local/app";
import { loadNoteTypes } from "@/server/structure/note-types";
import { newViewFormAction } from "../structure-actions";
import { loadStructure } from "../_lib/structure";

export async function ViewsPanes({ id, start }: { id: string | null; start: string | null }) {
  const user = await me();
  if (!user) redirect("/setup");
  const views = await getStore().listViews(user.id);
  const starters = starterViews().filter((s) => !views.some((v) => v.name === s.name));
  const view = id ? views.find((v) => v.id === id) ?? null : !start ? views[0] ?? null : null;
  const starter = start ? starters.find((s) => s.name === start) ?? null : !view ? starters[0] ?? null : null;
  const desc = (v: { source: string; layout: string; group?: string | null; filters: unknown[] }) =>
    `${v.layout === "kanban" ? "Kanban" : "Table"} · ${v.source === "items" ? "items" : "notes"}${v.group ? ` by ${fieldLabel(v.group).toLowerCase()}` : ""}${v.filters.length ? ` · ${v.filters.length} filter${v.filters.length === 1 ? "" : "s"}` : ""}`;
  const groups: LinkGroup[] = [
    { key: "yours", label: "Your views", rows: views.map((v) => ({ key: `v:${v.id}`, href: `/views/${encodeURIComponent(v.id)}`, title: v.name, sub: desc(v), mark: "sq", bold: true })), empty: "No views yet. Start from one below, or make your own." },
    ...(starters.length ? [{ key: "start", label: "Start from", rows: starters.map((s) => ({ key: `s:${s.name}`, href: `/views?start=${encodeURIComponent(s.name)}`, title: s.name, sub: desc(s), badge: s.layout === "kanban" ? "Kanban" : "Table", mark: "sq", bold: true })) }] : []),
    { key: "new", label: "Make your own", rows: [{ key: "new", href: "/views?start=new", title: "New view", sub: "Any filter over notes or items", mark: "ring" }] },
  ];
  const sel = view ? `v:${view.id}` : start === "new" ? "new" : starter ? `s:${starter.name}` : null;
  const list = (
    <>
      <ListBar title="Views" count={`${views.length} saved`} />
      <LinkGroups groups={groups} sel={sel} />
    </>
  );

  let detail;
  if (view) {
    const s = await loadStructure(user);
    const types = loadNoteTypes().types;
    // How each note property is edited in a cell: from the notes' types, else from the values.
    const propTypes: Record<string, string> = {};
    for (const n of s.notes) {
      for (const [k, v] of Object.entries(n.props)) {
        const key = `prop:${k}`;
        if (n.rawKeys?.includes(k)) { propTypes[key] = "raw"; continue; }
        if (propTypes[key] && v === null) continue;
        if (!propTypes[key] || propTypes[key] === "text") propTypes[key] = propTypeFor(k, v, typeOf(n.props, types));
      }
    }
    detail = (
      <div className="rp-wrap">
        <DetailBar crumb={[{ label: "Views", href: "/views" }, { label: view.name }]} listHref="/views" />
        <div className="rp-viewwrap">
          <ViewEditor key={view.id} initial={view} rows={view.source === "items" ? s.itemRows : s.notes}
            ctx={{ projects: s.projects, types: types.map((t) => t.name), propTypes, timeZone: user.timeZone, now: new Date().toISOString() }} />
        </div>
      </div>
    );
  } else {
    const isNew = start === "new" || !starter;
    detail = (
      <Detail bar={<DetailBar crumb={[{ label: "Views", href: "/views" }, { label: isNew ? "New view" : starter!.name }]} listHref="/views" />}>
        <Head kind={isNew ? "New view" : "Start from"} mark="sq" title={isNew ? "A view of your own" : starter!.name}
          lede={isNew ? "A saved filter over your notes (by type, property or tag) or items (by status, kind, person, project or tag), as a table or a board. It's kept with this workspace and shows in the sidebar." : `${desc(starter!)}. Add it, then change any filter.`} />
        <Sec title={isNew ? "Make it" : "Add it"}>
          {isNew ? (
            <form className="st-newview" action={newViewFormAction}>
              <input className="db-input" name="name" placeholder="New view name" aria-label="New view name" maxLength={60} autoComplete="off" required />
              <select className="db-input" name="source" aria-label="Over"><option value="items">Items</option><option value="notes">Notes</option></select>
              <select className="db-input" name="layout" aria-label="Layout"><option value="table">Table</option><option value="kanban">Kanban</option></select>
              <button className="rp-btn rp-btn--pri" type="submit">New view</button>
            </form>
          ) : (
            <form action={newViewFormAction}>
              <input type="hidden" name="name" value={starter!.name} />
              <input type="hidden" name="source" value={starter!.source} />
              <input type="hidden" name="layout" value={starter!.layout} />
              <input type="hidden" name="starter" value={JSON.stringify({ filters: starter!.filters, sort: starter!.sort, group: starter!.group })} />
              <button className="rp-cbtn rp-cbtn--pri" type="submit"><span className="rp-tick" aria-hidden="true" />Add this view</button>
            </form>
          )}
        </Sec>
      </Detail>
    );
  }
  return <Shell current={view ? `view:${view.id}` : "views"} list={list} detail={detail} show={id || start ? "detail" : "list"} />;
}
