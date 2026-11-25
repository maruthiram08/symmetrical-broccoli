import { notFound, redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { dateLabel } from "@/lib/brief/time";
import { getStore, me } from "@/server/local/app";
import { notesDir } from "@/server/local/paths";
import { pastDays } from "../../_lib/days";

export const dynamic = "force-dynamic";

// An earlier day: the note as it was written at brief time. The file in your notes folder is the source of truth.
export default async function Day({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();
  const user = await me();
  if (!user) redirect("/setup");
  const brief = (await getStore().listBriefs(user.id)).find((b) => b.date === date);
  if (!brief) notFound();
  const body = brief.markdown.replace(/^---[\s\S]*?---\n+/, "").replace(/^# .*\n+/, "");
  return (
    <Shell days={await pastDays(user.id, "")} current={date}>
      <h1 className="db-title">{dateLabel(date)}</h1>
      <p className="db-subtitle">
        <span className="db-mono">{`${notesDir().replace(/^\/Users\/[^/]+/, "~")}/${date}.md`}</span>
      </p>
      <pre className="db-md">{body}</pre>
    </Shell>
  );
}
