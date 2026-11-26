// Tags in the reading pane: every tag with its count in the list; the picked tag's numbers, what
// you owe and, above all, what was decided under it, in the detail.
import Link from "next/link";
import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { Detail, DetailBar, Head, IRows, LinkGroups, ListBar, MList, NoneDetail, Ppl, Sec, Stats, type LinkGroup } from "@/components/reading/Frame";
import { itemLine } from "@/lib/reading/library";
import { shortDay } from "@/lib/reading/model";
import { tagHref } from "@/lib/structure/tag-core";
import { hasTag, type TagNode } from "@/lib/structure/tags";

const flatten = (ns: TagNode[]): TagNode[] => ns.flatMap((n) => [n, ...flatten(n.children)]);
import { me } from "@/server/local/app";
import { loadAll } from "../_lib/lines";
import { readingCtx } from "../_lib/reading";
import { loadStructure } from "../_lib/structure";

export async function TagsPanes({ tag }: { tag: string | null }) {
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const s = await loadStructure(user);
  const { meetings } = await loadAll(user);
  const ctx = readingCtx(user, meetings, now);
  const flat = flatten(s.tree).sort((a, b) => b.items + b.notes - (a.items + a.notes) || a.tag.localeCompare(b.tag));
  const live = s.items.filter((i) => i.status !== "wrong");
  const openOf = (t: string) => live.filter((i) => hasTag(i.tags, t) && i.status === "open" && i.kind !== "decision").length;
  const decOf = (t: string) => live.filter((i) => hasTag(i.tags, t) && i.kind === "decision").length;
  const sel = tag ?? flat[0]?.tag ?? null;
  const groups: LinkGroup[] = [{
    key: "tags", label: "Most used",
    rows: flat.map((n) => {
      const o = openOf(n.tag), d = decOf(n.tag);
      return { key: n.tag, href: tagHref(n.tag), title: `#${n.tag}`, mark: "dot", bold: true, badge: String(n.items + n.notes), sub: [d ? `${d} decision${d === 1 ? "" : "s"}` : "", o ? `${o} open` : "", n.notes ? `${n.notes} note${n.notes === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "Nothing open" };
    }),
    empty: "No tags yet.",
  }];
  const list = (
    <>
      <ListBar title="Tags" count={flat.length} />
      <LinkGroups groups={groups} sel={sel} limit={40} foot={<>Tags come from #tag in a note, a <span className="db-mono">tags:</span> property, project keywords and #tag in quick capture. The number counts every item and note with it.</>} />
    </>
  );
  let detail;
  if (!sel) detail = <NoneDetail crumb={[{ label: "Tags" }]} listHref="/tags" text="No tags yet. Type #tag in a note or in quick capture." />;
  else {
    const its = live.filter((i) => hasTag(i.tags, sel));
    const owe = its.filter((i) => i.status === "open" && i.kind !== "decision");
    const decisions = its.filter((i) => i.kind === "decision").sort((a, b) => (ctx.meetings.get(b.meetingId)?.startedAt ?? b.createdAt).localeCompare(ctx.meetings.get(a.meetingId)?.startedAt ?? a.createdAt));
    const kept = its.filter((i) => i.status === "done").length;
    const notes = s.notes.filter((n) => hasTag(n.tags, sel)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const mids = [...new Set(its.map((i) => i.meetingId))].map((id) => ctx.meetings.get(id)).filter((m) => !!m).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const project = s.projects.find((p) => p.slug === sel || p.slug === sel.split("/")[0]);
    const co = new Map<string, number>();
    for (const i of its) for (const t of i.tags ?? []) if (t !== sel && !t.startsWith(`${sel}/`)) co.set(t, (co.get(t) ?? 0) + 1);
    const often = [...co].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => `#${t}`);
    const node = flat.find((n) => n.tag === sel);
    const first = mids[mids.length - 1];
    const ihref = (id: string) => `/item/${encodeURIComponent(id)}`;
    detail = (
      <Detail
        bar={<DetailBar crumb={[{ label: "Tags", href: "/tags" }, { label: `#${sel}` }]} listHref="/tags" acts={project ? <Link className="rp-btn rp-btn--pri" href={`/projects?project=${encodeURIComponent(project.slug)}`}>Open the project</Link> : null} />}
        rail={<>
          {project ? <Sec title="Project"><MList rows={[{ key: project.slug, label: project.title, right: "project", href: `/projects?project=${encodeURIComponent(project.slug)}` }]} /></Sec> : null}
          <Sec title="Often with"><Ppl names={often} href={(t) => tagHref(t.slice(1))} empty="No other tags on these items." /></Sec>
          {node?.children.length ? <Sec title="Nested tags"><Ppl names={node.children.map((c) => `#${c.tag}`)} href={(t) => tagHref(t.slice(1))} /></Sec> : null}
          <Sec title="Latest meetings"><MList rows={mids.slice(0, 4).map((m) => ({ key: m.id, label: m.title || "Meeting", right: shortDay(m.startedAt, user.timeZone), href: `/meeting/${encodeURIComponent(m.id)}` }))} empty="No meetings yet." /></Sec>
        </>}
      >
        <Head kind="Tag" mark="dot" title={`#${sel}`}
          lede={mids.length ? `Came up in ${mids.length} meeting${mids.length === 1 ? "" : "s"} since ${shortDay(first!.startedAt, user.timeZone)}. ${decisions.length ? `${decisions.length} decision${decisions.length === 1 ? "" : "s"}, ` : ""}${owe.length ? `${owe.length} open.` : "nothing open."}` : `${notes.length} note${notes.length === 1 ? "" : "s"} and ${its.length} item${its.length === 1 ? "" : "s"}.`} />
        <Stats items={[{ n: mids.length, label: "Meetings" }, { n: decisions.length, label: "Decisions" }, { n: owe.length, label: "Open" }, { n: kept, label: "Kept" }]} />
        <Sec title={`Open · ${owe.length}`}><IRows rows={owe.map((i) => itemLine(i, ctx, ihref(i.id)))} empty={`Nothing open with #${sel}.`} /></Sec>
        <Sec title={`What was decided · ${decisions.length}`}><IRows rows={decisions.map((i) => itemLine(i, ctx, ihref(i.id), { small: "meeting" }))} empty="No decisions with this tag." /></Sec>
        {notes.length ? <Sec title={`Notes · ${notes.length}`}><IRows rows={notes.map((n) => ({ key: n.slug, href: `/notes/${encodeURIComponent(n.slug)}`, mark: "sq", title: n.title, small: n.typeName ?? "", badge: shortDay(n.updatedAt, user.timeZone) }))} /></Sec> : null}
      </Detail>
    );
  }
  return <Shell current="tags" list={list} detail={detail} show={tag ? "detail" : "list"} />;
}
