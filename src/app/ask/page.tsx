import { redirect } from "next/navigation";
import { AskBox } from "@/components/AskBox";
import { Shell } from "@/components/Shell";
import { me, getStore } from "@/server/local/app";
import { pastDays } from "../_lib/days";

export const dynamic = "force-dynamic";

// Ask a question about your meetings; Claude answers from your items and cites them.
export default async function Ask({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const q = ((await searchParams).q ?? "").slice(0, 500).trim();
  const openCount = (await getStore().listItems(user.id, { status: "open" })).filter((i) => i.kind !== "decision").length;
  return (
    <Shell days={await pastDays(user.id, "")} current="ask" openCount={openCount}>
      <h1 className="db-title">Ask</h1>
      <p className="db-subtitle">Ask about what was promised and decided. Answers come only from your items, with the quote behind each one.</p>
      <AskBox initial={q} hasKey={!!process.env.ANTHROPIC_API_KEY} />
    </Shell>
  );
}
