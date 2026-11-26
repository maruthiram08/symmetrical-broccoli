import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { ShareToTeam } from "@/components/ShareToTeam";
import { ItemDetail } from "@/components/reading/ItemDetail";
import { ItemStructure } from "@/components/structure/ItemStructure";
import { me } from "@/server/local/app";
import { pastDays } from "../../_lib/days";
import { loadAll } from "../../_lib/lines";
import { allTags, loadStructure } from "../../_lib/structure";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await me();
  const item = user ? (await loadAll(user)).items.find((i) => i.id === decodeURIComponent(id)) : undefined;
  return { title: item?.text ?? "History" };
}

// One item on its own page: the same detail as the reading pane, plus related earlier items, its
// tags and project, and team sharing (hosted).
export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await me();
  if (!user) redirect("/setup");
  const now = new Date();
  const { items, meetings } = await loadAll(user);
  const item = items.find((i) => i.id === decodeURIComponent(id));
  if (!item) notFound();
  const structure = item.status !== "wrong" ? await loadStructure(user) : null;
  const href = (x: string) => `/item/${encodeURIComponent(x)}`;
  const crumb = item.kind !== "decision" && item.status === "open" ? { page: "All open", pageHref: "/open" } : { page: "Today", pageHref: "/" };
  return (
    <Shell
      days={await pastDays(user.id, "")}
      current="item"
      pane={
        <ItemDetail
          item={item} items={items} meetings={meetings} user={user} now={now}
          crumb={{ ...crumb, group: item.text.length > 48 ? `${item.text.slice(0, 46)}…` : item.text }}
          selfHref={href(item.id)} itemHref={href} full
          extra={<>
            <ShareToTeam itemId={item.id} />
            {structure ? (
              <section className="rp-sec">
                <h2>Tags and project</h2>
                <ItemStructure itemId={item.id} project={item.project ?? null} tags={item.tags ?? []} projects={structure.projects} known={allTags(structure)} />
              </section>
            ) : null}
          </>}
        />
      }
    />
  );
}
