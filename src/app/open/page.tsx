import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { EmptyDetail, ItemDetail } from "@/components/reading/ItemDetail";
import { ItemList, MenuLink } from "@/components/reading/ListPane";
import { openGroups, type OpenGrouping } from "@/lib/reading/model";
import { projectLabel } from "@/lib/structure/views";
import { me } from "@/server/local/app";
import { projectRows } from "@/server/structure/notes";
import { pastDays } from "../_lib/days";
import { loadAll } from "../_lib/lines";
import { groupIds, groupOf, readingCtx, withParams } from "../_lib/reading";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "All open" };

// Everything you owe or wait on, grouped by the day it comes back (or by person, or by project:
// ?group=person, ?group=project). The selected item (?item=<id>) shows on the right.
export default async function AllOpen({ searchParams }: { searchParams: Promise<{ group?: string; item?: string; undo?: string; was?: string }> }) {
  const sp = await searchParams;
  const by: OpenGrouping = sp.group === "project" || sp.group === "person" ? sp.group : "day";
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings } = await loadAll(user);
  const ctx = readingCtx(user, meetings, now);
  let titles = new Map<string, string>();
  try { titles = new Map(projectRows().map((p) => [p.slug, p.title])); } catch { /* no notes folder */ }
  const groups = openGroups(items, ctx, by, (s) => titles.get(s) ?? projectLabel(s));
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const group = by === "day" ? undefined : by;
  const href = (id: string) => withParams("/open", { group, item: id });
  const chosen = sp.item ? items.find((i) => i.id === sp.item) : undefined;
  const firstId = groups[0]?.rows[0]?.id;
  const selected = chosen ?? (firstId ? items.find((i) => i.id === firstId) : undefined);
  const options = (
    <>
      <MenuLink href={withParams("/open", {})} on={by === "day"}>Group by the day it comes back</MenuLink>
      <MenuLink href={withParams("/open", { group: "person" })} on={by === "person"}>Group by person</MenuLink>
      <MenuLink href={withParams("/open", { group: "project" })} on={by === "project"}>Group by project</MenuLink>
    </>
  );
  return (
    <Shell
      days={await pastDays(user.id, "")}
      current="open"
      reading={{ groups: groupIds(groups), param: "item", selected: selected?.id ?? null, auto: !chosen }}
      list={<ItemList title="All open" count={String(total)} options={options} groups={groups} hrefBase={withParams("/open", { group })} undo={{ id: sp.undo, was: sp.was, back: withParams("/open", { group, item: sp.item }) }} />}
      detail={selected ? (
        <ItemDetail item={selected} items={items} meetings={meetings} user={user} now={now}
          crumb={{ page: "All open", group: groupOf(groups, selected.id) }} inPane selfHref={href(selected.id)} itemHref={href} />
      ) : <EmptyDetail text="Nothing open. Everything you owe and wait on shows here." />}
    />
  );
}

