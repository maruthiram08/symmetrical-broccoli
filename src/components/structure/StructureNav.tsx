import Link from "next/link";
import { getStore, me } from "@/server/local/app";

/** Sidebar: Tags, Views, and one entry per saved view. */
export async function StructureNav({ current }: { current: string }) {
  const user = await me();
  const views = user ? await getStore().listViews(user.id).catch(() => []) : [];
  return (
    <>
      <Link className="db-nav" href="/tags" aria-current={current === "tags" ? "page" : undefined}>Tags</Link>
      <Link className="db-nav" href="/views" aria-current={current === "views" ? "page" : undefined}>Views</Link>
      {views.map((v) => (
        <Link key={v.id} className="db-nav st-nav-view" href={`/views/${encodeURIComponent(v.id)}`} aria-current={current === `view:${v.id}` ? "page" : undefined}>
          {v.name}
        </Link>
      ))}
    </>
  );
}
