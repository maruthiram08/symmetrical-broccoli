import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { NameReview } from "@/components/NameReview";
import { Shell } from "@/components/Shell";
import { confirmed } from "@/lib/directory/directory";
import { namesToCheck } from "@/lib/directory/review";
import { me } from "@/server/local/app";
import { pastDays } from "../../_lib/days";
import { loadAll, shortDate } from "../../_lib/lines";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Check names" };

// Names transcription guessed: say who each one is, once, and every page uses the answer.
export default async function CheckNames() {
  const user = await me();
  if (!user) redirect("/setup");
  const { items, meetings, people } = await loadAll(user);
  const known = confirmed({ people, moved: {} });
  const names = namesToCheck({ items, meetings, people: known, self: [user.name, ...user.aliases] });
  const lastSeen = Object.fromEntries(names.filter((n) => n.lastSeenAt).map((n) => [n.key, shortDate(n.lastSeenAt!, user.timeZone)]));
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;

  return (
    <Shell days={await pastDays(user.id, "")} current="people" openCount={openCount}>
      <p className="db-crumb"><Link className="db-link" href="/people">People</Link></p>
      <h1 className="db-title">Check names</h1>
      <p className="db-subtitle">
        Transcription guesses names. Say who each one is: the same as someone you know, a new person, or not a person at all.
        Every page and future meetings use your answer.
      </p>
      <NameReview
        names={names}
        people={known.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name))}
        lastSeen={lastSeen}
      />
    </Shell>
  );
}
