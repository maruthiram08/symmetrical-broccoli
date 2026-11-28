import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CloseMoment } from "@/components/CloseWrap";
import { ContradictionCards } from "@/components/ContradictionCards";
import { ExportMenu } from "@/components/ExportMenu";
import { PrepCard } from "@/components/PrepCard";
import { Shell } from "@/components/Shell";
import { ItemDetail } from "@/components/reading/ItemDetail";
import { ItemList, MenuLink } from "@/components/reading/ListPane";
import { TodayOverview } from "@/components/reading/TodayOverview";
import { TodayRoutines } from "@/components/routines/TodayRoutines";
import { formatTime, localDate } from "@/lib/brief/time";
import { dayName, todayGroups } from "@/lib/reading/model";
import { routinesDue } from "@/lib/routines/schedule";
import { getStore, me } from "@/server/local/app";
import { takeCloseMoment } from "@/server/local/closewrap";
import { onboardingStep } from "@/server/local/onboarding";
import { prepCard } from "@/server/local/prep";
import { pullState } from "@/server/local/scheduler";
import { routineStore } from "@/server/routines";
import { checkMeetingsNow } from "./actions";
import { pastDays } from "./_lib/days";
import { loadAll } from "./_lib/lines";
import { groupIds, groupOf, readingCtx, withParams } from "./_lib/reading";

/** "in 22 min", "in 1 h 5 min" */
function minutesUntil(iso: string, now: Date): string {
  const m = Math.max(1, Math.round((Date.parse(iso) - now.getTime()) / 60000));
  return m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: { absolute: "Today · Daily brief" } };

// Today: Late, today's brief, Back tomorrow and Kept today in the list; the day's overview in the
// detail until you pick an item (?item=<id>).
export default async function Today({ searchParams }: { searchParams: Promise<{ undo?: string; was?: string; item?: string }> }) {
  const user = await me();
  if (!user) redirect("/welcome");
  const store = getStore();
  const conn = await store.getConnection(user.id);
  if (onboardingStep(user, conn, pullState()?.running ?? false) !== "done") redirect("/welcome");
  if (!conn) redirect("/welcome");

  const now = new Date();
  const { undo, was, item: want } = await searchParams;
  const { items, meetings } = await loadAll(user);
  const ctx = readingCtx(user, meetings, now);
  const groups = todayGroups(items, ctx);
  const today = localDate(now, user.timeZone);
  const selected = want ? items.find((i) => i.id === want) ?? null : null;
  const href = (id: string) => withParams("/", { item: id });

  let detail;
  if (selected) {
    detail = (
      <ItemDetail
        item={selected} items={items} meetings={meetings} user={user} now={now}
        crumb={{ page: "Today", group: groupOf(groups, selected.id) ?? "Item" }}
        back={{ href: "/", label: "Overview" }}
        inPane selfHref={href(selected.id)} itemHref={href}
      />
    );
  } else {
    // Shown only on the overview: taking the close moment marks it seen.
    const closed = await takeCloseMoment(store, user, now);
    const prep = await prepCard(store, user, now);
    const rs = routineStore(store);
    const routines = rs ? routinesDue(await rs.listRoutines(user.id), await rs.listOccurrences(user.id), today, user.timeZone) : [];
    detail = (
      <TodayOverview
        items={items} meetings={meetings} ctx={ctx} href={href}
        extras={<>
          {prep ? <PrepCard prep={prep} time={formatTime(prep.meeting.startsAt, user.timeZone)} inLabel={minutesUntil(prep.meeting.startsAt, now)} nowMs={now.getTime()} /> : null}
          <ContradictionCards user={user} />
          <CloseMoment lines={closed} />
        </>}
        after={routines.length ? <div className="rp-legacy"><TodayRoutines lines={routines} today={today} /></div> : null}
      />
    );
  }

  const options = (
    <>
      <MenuLink href="/today">Today with its note</MenuLink>
      <MenuLink href="/wrap">Evening wrap</MenuLink>
      <MenuLink href="/week">This week</MenuLink>
      <div className="rp-menu__sub"><ExportMenu type="day" id="today" label="Export brief" /></div>
    </>
  );

  return (
    <Shell
      days={await pastDays(user.id, today)}
      current="today"
      footer={<form action={checkMeetingsNow}><button className="db-nav db-nav--button" type="submit">Check meetings now</button></form>}
      reading={{ groups: groupIds(groups), param: "item", selected: selected?.id ?? null }}
      list={<ItemList title="Today" count={dayName(today)} options={options} groups={groups} hrefBase="/" undo={{ id: undo, was, back: withParams("/", { item: want }) }} />}
      detail={detail}
    />
  );
}
