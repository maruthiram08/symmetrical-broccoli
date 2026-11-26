import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { InboxRow } from "@/components/InboxRow";
import { Shell } from "@/components/Shell";
import { listPeople } from "@/lib/people";
import { me } from "@/server/local/app";
import { pastDays } from "../_lib/days";
import { loadAll, shortDate } from "../_lib/lines";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Inbox" };

// Things you jotted down without a person or a date, oldest first, waiting to be sorted.
export default async function Inbox() {
  const user = await me();
  if (!user) redirect("/setup");
  const { items, meetings } = await loadAll(user);
  const inbox = items.filter((i) => i.status === "inbox").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const openCount = items.filter((i) => i.status === "open" && i.kind !== "decision").length;
  const people = listPeople({ items, meetings, now: new Date(), self: [user.name, ...user.aliases] }).map((p) => p.name);

  return (
    <Shell days={await pastDays(user.id, "")} current="inbox" openCount={openCount}>
      <h1 className="db-title">Inbox</h1>
      <p className="db-subtitle">
        {inbox.length
          ? "Things you added without a person or a date. Give each one a home, or delete it."
          : "Nothing to sort. Anything you add with c that names no one and no day lands here."}
      </p>
      {inbox.length ? (
        <ul className="ib-list" aria-label="Inbox">
          {inbox.map((i) => (
            <InboxRow key={i.id} people={people}
              item={{ id: i.id, text: i.text, note: i.note ?? null, kind: i.kind === "waiting" ? "waiting" : "owe", added: `Added ${shortDate(i.createdAt, user.timeZone)}` }} />
          ))}
        </ul>
      ) : null}
    </Shell>
  );
}
