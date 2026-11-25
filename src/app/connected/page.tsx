import { Page } from "@/components/Page";
import { getUserSettings } from "@/lib/auth";
import { readSession } from "@/lib/session-cookie";
import { formatBriefTime, nextBriefDay } from "../_lib/time";

export const dynamic = "force-dynamic";

function count(v: string | undefined): number | null {
  if (v === undefined || !/^\d{1,6}$/.test(v)) return null;
  return Number(v);
}

export default async function Connected({ searchParams }: { searchParams: Promise<{ m?: string; p?: string; o?: string }> }) {
  const sp = await searchParams;
  const uid = await readSession();
  const user = uid ? await getUserSettings(uid).catch(() => null) : null;
  const briefTime = user?.briefTime ?? "18:00";
  const day = nextBriefDay(briefTime, user?.timeZone ?? "Asia/Kolkata");
  const [m, p, o] = [count(sp.m), count(sp.p), count(sp.o)];

  let backfill: string | null = null;
  if (p !== null && o !== null) {
    const promises = `${p} ${p === 1 ? "promise" : "promises"}`;
    const what = m !== null ? `${m} ${m === 1 ? "meeting" : "meetings"} from your last 7 days` : "your last 7 days";
    backfill = `We read ${what}: ${promises}, ${o} still open.`;
  }

  return (
    <Page title="You're set.">
      <p className="db-lead">
        Your first brief arrives {day} at <span className="db-mono">{formatBriefTime(briefTime)}</span>.
      </p>
      {backfill ? <p>{backfill}</p> : null}
    </Page>
  );
}
